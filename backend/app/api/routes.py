from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from pathlib import Path
from rq.command import send_stop_job_command
from rq.job import Job

from app.queue import get_queue, get_redis
from app.core.config import settings
from app.workers.flow_job import run_flow
from app.services.storage import gdrive
from app.services.storage.gdrive_ops import list_employee_folders, list_year_folders
from app.services.auth import google_oauth

router = APIRouter()

@router.get("/health")
async def health():
    return {"status": "ok"}

@router.get("/drive/files")
async def list_drive_files(
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    try:
        files = list(
            gdrive.list_files_in_folder(
                settings.drive_input_folder_id,
                query_extra="mimeType = 'application/pdf'",
                tenant_id=tenant_id,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/employees")
async def list_employee_folders_endpoint(
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    try:
        folders = list_employee_folders(settings.drive_root_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.get("/drive/employees/{employee_folder_id}/years")
async def list_employee_years(
    employee_folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    try:
        folders = list_year_folders(employee_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.get("/drive/folders/{folder_id}/files")
async def list_files_in_folder_endpoint(
    folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    try:
        files = list(gdrive.list_files_in_folder(folder_id, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/files/{file_id}/download")
async def download_drive_file(file_id: str, tenant_id: str = Query("default")):
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"{file_id}.pdf"
    try:
        gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Download failed: {exc}")

    if not local_path.exists() or local_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Downloaded file is empty or missing")

    return FileResponse(
        path=str(local_path),
        media_type="application/pdf",
        filename=f"{file_id}.pdf",
    )

@router.post("/ingest/drive")
async def ingest_drive(tenant_id: str = Query("default")):
    redis_conn = get_redis()
    lock_key = f"recibox:lock:{tenant_id}"

    # Prevent concurrent runs for same tenant.
    if not redis_conn.set(lock_key, "1", nx=True, ex=60 * 60):
        raise HTTPException(status_code=409, detail="Processing already running for tenant")

    q = get_queue()
    job = q.enqueue(run_flow, tenant_id=tenant_id, job_timeout=settings.rq_job_timeout_seconds)
    job.meta["tenant_id"] = tenant_id
    job.save_meta()
    return {"status": "queued", "job_id": job.id, "tenant_id": tenant_id}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=get_redis())
    except Exception:
        raise HTTPException(status_code=404, detail="Job not found")

    duration_seconds = None
    if job.started_at:
        end = job.ended_at or None
        if end:
            duration_seconds = (end - job.started_at).total_seconds()
        else:
            duration_seconds = (job.last_heartbeat or job.started_at)
            duration_seconds = (duration_seconds - job.started_at).total_seconds()

    return {
        "job_id": job.id,
        "status": job.get_status(),
        "result": job.result,
        "created_at": job.created_at,
        "enqueued_at": job.enqueued_at,
        "started_at": job.started_at,
        "ended_at": job.ended_at,
        "duration_seconds": duration_seconds,
    }


@router.post("/jobs/{job_id}/stop")
async def stop_job(job_id: str):
    try:
        job = Job.fetch(job_id, connection=get_redis())
    except Exception:
        raise HTTPException(status_code=404, detail="Job not found")

    redis_conn = get_redis()
    tenant_id = job.meta.get("tenant_id", "default")
    lock_key = f"recibox:lock:{tenant_id}"

    try:
        send_stop_job_command(redis_conn, job_id)
    except Exception:
        pass

    try:
        job.cancel()
    except Exception:
        pass

    try:
        redis_conn.delete(lock_key)
    except Exception:
        pass

    return {"status": "stop_requested", "job_id": job_id, "tenant_id": tenant_id}

@router.post("/process/{file_id}")
async def process_file(file_id: str):
    return {"file_id": file_id, "status": "queued"}


@router.get("/auth/google/login")
async def google_oauth_login(tenant_id: str = Query("default")):
    try:
        url = google_oauth.get_authorization_url(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return RedirectResponse(url=url)


@router.get("/auth/google/callback")
async def google_oauth_callback(code: str, state: str = Query("default")):
    try:
        google_oauth.exchange_code_for_token(state, code)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "tenant_id": state}
