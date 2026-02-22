from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from pathlib import Path
import json
from urllib.parse import quote
from pydantic import BaseModel
from rq.command import send_stop_job_command
from rq.job import Job

from app.queue import get_queue, get_redis
from app.core.config import settings
from app.workers.flow_job import run_flow
from app.services.storage import gdrive
from app.services.storage.gdrive_ops import (
    ensure_employee_folder,
    ensure_year_folder,
    list_employee_folders,
    list_year_folders,
)
from app.services.auth import google_oauth
from app.services.tenants.drive_config import (
    clear_tenant_drive_config,
    is_tenant_disabled,
    load_tenant_drive_config,
    resolve_tenant_drive_config,
    save_tenant_drive_config,
    set_tenant_disabled,
)
from app.services.tenants.processing_preferences import (
    clear_tenant_processing_preferences,
    load_tenant_processing_preferences,
    resolve_tenant_processing_preferences,
    save_tenant_processing_preferences,
)

router = APIRouter()


class TenantDriveConfigPayload(BaseModel):
    drive_input_folder_id: str
    drive_root_folder_id: str
    drive_recibox_folder_id: str | None = None


class CreateDriveFolderPayload(BaseModel):
    parent_id: str
    name: str


class CreateReciboxStructurePayload(BaseModel):
    parent_id: str


class CreateReciboxInputPayload(BaseModel):
    recibox_folder_id: str
    root_parent_id: str | None = None


class AdoptReciboxFolderPayload(BaseModel):
    folder_id: str
    parent_id: str = "root"


class CreateEmployeePayload(BaseModel):
    employee_name: str


class CreateEmployeeYearPayload(BaseModel):
    year: str


class FilenameCustomFormatPayload(BaseModel):
    part1: str = "MM"
    sep1: str = "-"
    part2: str = "YYYY"
    sep2: str = ")"
    part3: str = "EMPLOYEE"


class ProcessingPreferencesPayload(BaseModel):
    filename_format_mode: str
    filename_custom_format: FilenameCustomFormatPayload | None = None
    employee_folder_number_mode: str = "indexed_number"
    employee_folder_number_custom_part1: str | None = None
    employee_folder_number_custom_part2: str | None = None
    auto_create_missing_employee_folder: bool = True


def _ensure_tenant_active(tenant_id: str) -> None:
    redis_conn = get_redis()
    if is_tenant_disabled(redis_conn, tenant_id):
        raise HTTPException(
            status_code=403,
            detail=f"Tenant '{tenant_id}' is unlinked. Re-link OAuth to continue.",
        )


def _resolve_drive_config_or_400(tenant_id: str):
    redis_conn = get_redis()
    try:
        return resolve_tenant_drive_config(redis_conn, tenant_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/health")
async def health():
    return {"status": "ok"}

@router.get("/drive/files")
async def list_drive_files(
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        files = list(
            gdrive.list_files_in_folder(
                cfg.drive_input_folder_id,
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
    _ensure_tenant_active(tenant_id)
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        folders = list_employee_folders(cfg.recibox_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.post("/drive/employees")
async def create_employee_folder(
    payload: CreateEmployeePayload,
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    employee_name = payload.employee_name.strip()
    if not employee_name:
        raise HTTPException(status_code=400, detail="employee_name is required")
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        folder = ensure_employee_folder(cfg.recibox_folder_id, employee_name, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create employee folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.get("/drive/employees/{employee_folder_id}/years")
async def list_employee_years(
    employee_folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    try:
        folders = list_year_folders(employee_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.post("/drive/employees/{employee_folder_id}/years")
async def create_employee_year_folder(
    employee_folder_id: str,
    payload: CreateEmployeeYearPayload,
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    year = payload.year.strip()
    if not year:
        raise HTTPException(status_code=400, detail="year is required")
    try:
        folder = ensure_year_folder(employee_folder_id, year, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create year folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.get("/drive/employees/{employee_folder_id}/files")
async def list_employee_files(
    employee_folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    try:
        files = list(gdrive.list_files_in_folder(employee_folder_id, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/folders/{folder_id}/files")
async def list_files_in_folder_endpoint(
    folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
):
    _ensure_tenant_active(tenant_id)
    try:
        files = list(gdrive.list_files_in_folder(folder_id, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/picker/folders")
async def list_picker_folders(
    tenant_id: str = Query("default"),
    parent_id: str = Query("root"),
    limit: int | None = Query(None, ge=1, le=1000),
):
    _ensure_tenant_active(tenant_id)
    query = "mimeType = 'application/vnd.google-apps.folder'"
    try:
        folders = list(gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "parent_id": parent_id, "folders": folders}

    return {
        "count": min(len(folders), limit),
        "parent_id": parent_id,
        "folders": folders[:limit],
    }


@router.post("/drive/picker/folders")
async def create_picker_folder(payload: CreateDriveFolderPayload, tenant_id: str = Query("default")):
    _ensure_tenant_active(tenant_id)
    name = payload.name.strip()
    if not payload.parent_id.strip():
        raise HTTPException(status_code=400, detail="parent_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        folder = gdrive.create_folder(payload.parent_id.strip(), name, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.post("/drive/picker/recibox-structure")
async def create_recibox_structure(
    payload: CreateReciboxStructurePayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
):
    _ensure_tenant_active(tenant_id)
    parent_id = payload.parent_id.strip()
    if not parent_id:
        raise HTTPException(status_code=400, detail="parent_id is required")
    try:
        recibox_folder = gdrive.ensure_folder(parent_id, "RECIBOX", tenant_id=tenant_id)
        input_folder = gdrive.ensure_folder(recibox_folder["id"], "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create structure failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=parent_id,
            drive_recibox_folder_id=recibox_folder["id"],
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "parent_id": parent_id,
        "root_folder": recibox_folder,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.get("/drive/picker/recibox-structure/check")
async def check_recibox_structure(
    tenant_id: str = Query("default"),
    parent_id: str = Query("root"),
):
    _ensure_tenant_active(tenant_id)
    parent = parent_id.strip()
    if not parent:
        raise HTTPException(status_code=400, detail="parent_id is required")

    try:
        recibox_folder = gdrive.find_folder_by_name(parent, "RECIBOX", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Check structure failed: {exc}")

    if not recibox_folder:
        return {
            "status": "missing_recibox",
            "parent_id": parent,
            "recibox_exists": False,
            "input_exists": False,
            "recibox_folder_id": None,
            "input_folder_id": None,
        }

    try:
        input_folder = gdrive.find_folder_by_name(recibox_folder["id"], "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Check structure failed: {exc}")

    if not input_folder:
        return {
            "status": "missing_input",
            "parent_id": parent,
            "recibox_exists": True,
            "input_exists": False,
            "recibox_folder_id": recibox_folder["id"],
            "input_folder_id": None,
        }

    return {
        "status": "complete",
        "parent_id": parent,
        "recibox_exists": True,
        "input_exists": True,
        "recibox_folder_id": recibox_folder["id"],
        "input_folder_id": input_folder["id"],
    }


@router.post("/drive/picker/recibox-input")
async def create_recibox_input(
    payload: CreateReciboxInputPayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
):
    _ensure_tenant_active(tenant_id)
    recibox_folder_id = payload.recibox_folder_id.strip()
    if not recibox_folder_id:
        raise HTTPException(status_code=400, detail="recibox_folder_id is required")

    try:
        input_folder = gdrive.ensure_folder(recibox_folder_id, "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create input folder failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        current_cfg = load_tenant_drive_config(redis_conn, tenant_id)
        fallback_root = (settings.drive_root_folder_id or "").strip()
        root_parent_id = (payload.root_parent_id or "").strip() or (
            current_cfg.drive_root_folder_id if current_cfg else fallback_root or recibox_folder_id
        )
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=root_parent_id,
            drive_recibox_folder_id=recibox_folder_id,
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "recibox_folder_id": recibox_folder_id,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.post("/drive/picker/recibox-structure/adopt-folder")
async def adopt_recibox_folder(
    payload: AdoptReciboxFolderPayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
):
    _ensure_tenant_active(tenant_id)
    folder_id = payload.folder_id.strip()
    parent_id = payload.parent_id.strip() or "root"
    if not folder_id:
        raise HTTPException(status_code=400, detail="folder_id is required")

    query = "mimeType = 'application/vnd.google-apps.folder'"
    try:
        root_folders = list(gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    selected_folder = next((folder for folder in root_folders if folder.get("id") == folder_id), None)
    if not selected_folder:
        raise HTTPException(status_code=404, detail="Selected folder was not found in parent")

    existing_recibox = next(
        (
            folder
            for folder in root_folders
            if folder.get("name") == "RECIBOX" and folder.get("id") != folder_id
        ),
        None,
    )
    if existing_recibox:
        raise HTTPException(status_code=409, detail="A different RECIBOX folder already exists in parent")

    try:
        recibox_folder = gdrive.update_file_metadata(
            folder_id,
            tenant_id=tenant_id,
            new_name="RECIBOX",
        )
        input_folder = gdrive.ensure_folder(folder_id, "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Adopt folder failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=parent_id,
            drive_recibox_folder_id=recibox_folder["id"],
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "parent_id": parent_id,
        "root_folder": recibox_folder,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.get("/drive/files/{file_id}/download")
async def download_drive_file(file_id: str, tenant_id: str = Query("default")):
    _ensure_tenant_active(tenant_id)
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
    _ensure_tenant_active(tenant_id)
    redis_conn = get_redis()
    cfg = _resolve_drive_config_or_400(tenant_id)
    lock_key = f"recibox:lock:{tenant_id}"

    # Prevent concurrent runs for same tenant.
    if not redis_conn.set(lock_key, "1", nx=True, ex=60 * 60):
        raise HTTPException(status_code=409, detail="Processing already running for tenant")

    q = get_queue()
    job = q.enqueue(run_flow, tenant_id=tenant_id, job_timeout=settings.rq_job_timeout_seconds)
    job.meta["tenant_id"] = tenant_id
    job.save_meta()
    return {
        "status": "queued",
        "job_id": job.id,
        "tenant_id": tenant_id,
        "drive_config_source": cfg.source,
    }


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
async def google_oauth_login(
    tenant_id: str = Query("default"),
    popup: bool = Query(False),
):
    try:
        state_payload = {"tenant_id": tenant_id, "popup": popup}
        url = google_oauth.get_authorization_url(json.dumps(state_payload))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return RedirectResponse(url=url)


def _parse_oauth_state(state: str) -> tuple[str, bool]:
    try:
        data = json.loads(state)
    except Exception:
        return state, False
    if not isinstance(data, dict):
        return state, False
    tenant_id = str(data.get("tenant_id", "default"))
    popup = bool(data.get("popup", False))
    return tenant_id, popup


def _oauth_popup_callback_html(tenant_id: str, ok: bool, message: str) -> str:
    payload = {
        "source": "recibox-oauth",
        "ok": ok,
        "tenant_id": tenant_id,
        "message": message,
    }
    payload_json = json.dumps(payload)
    payload_param = quote(payload_json, safe="")
    return f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>RECIBOX OAuth</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {{ font-family: Arial, sans-serif; margin: 24px; }}
      .ok {{ color: #15803d; }}
      .error {{ color: #b91c1c; }}
    </style>
  </head>
  <body>
    <h3 class="{("ok" if ok else "error")}">{("Cuenta conectada correctamente" if ok else "Error al conectar la cuenta")}</h3>
    <p>{message}</p>
    <script src="/auth/google/popup-bridge.js?payload={payload_param}"></script>
  </body>
</html>"""


@router.get("/auth/google/popup-bridge.js")
async def google_oauth_popup_bridge(payload: str = Query("{}")):
    try:
        parsed = json.loads(payload)
        if not isinstance(parsed, dict):
            parsed = {}
    except Exception:
        parsed = {}
    payload_json = json.dumps(parsed)
    js = f"""(function () {{
  const payload = {payload_json};
  try {{
    if (window.opener) {{
      window.opener.postMessage(payload, "*");
    }}
  }} catch (_err) {{}}
  setTimeout(function () {{ window.close(); }}, 120);
}})();"""
    return Response(content=js, media_type="application/javascript")


@router.get("/auth/google/callback")
async def google_oauth_callback(code: str, state: str = Query("default")):
    tenant_id, popup = _parse_oauth_state(state)
    try:
        google_oauth.exchange_code_for_token(tenant_id, code)
        redis_conn = get_redis()
        set_tenant_disabled(redis_conn, tenant_id, False)
    except Exception as exc:
        if popup:
            return HTMLResponse(
                content=_oauth_popup_callback_html(
                    tenant_id=tenant_id,
                    ok=False,
                    message=str(exc),
                )
            )
        raise HTTPException(status_code=500, detail=str(exc))

    if popup:
        return HTMLResponse(
            content=_oauth_popup_callback_html(
                tenant_id=tenant_id,
                ok=True,
                message=f"Tenant '{tenant_id}' vinculado.",
            )
        )

    return {"status": "ok", "tenant_id": tenant_id}


@router.get("/auth/google/status")
async def google_oauth_status(tenant_id: str = Query("default")):
    try:
        return google_oauth.get_token_status(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/auth/google/unlink")
async def google_oauth_unlink(
    tenant_id: str = Query("default"),
    clear_drive_config: bool = Query(True),
    clear_lock: bool = Query(True),
    disable_tenant: bool = Query(True),
):
    try:
        result = google_oauth.unlink_tenant_oauth(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    redis_conn = get_redis()
    if clear_drive_config:
        result["deleted_drive_config"] = clear_tenant_drive_config(redis_conn, tenant_id)
    else:
        result["deleted_drive_config"] = False

    if clear_lock:
        lock_key = f"recibox:lock:{tenant_id}"
        result["deleted_lock"] = bool(redis_conn.delete(lock_key))
    else:
        result["deleted_lock"] = False

    if disable_tenant:
        set_tenant_disabled(redis_conn, tenant_id, True)
        result["tenant_disabled"] = True
    else:
        result["tenant_disabled"] = False

    has_custom = load_tenant_drive_config(redis_conn, tenant_id) is not None
    result["post_unlink"] = {
        "oauth": google_oauth.get_token_status(tenant_id),
        "has_custom_drive_config": has_custom,
        "tenant_disabled": is_tenant_disabled(redis_conn, tenant_id),
    }

    return result


@router.post("/auth/google/refresh")
async def google_oauth_refresh(tenant_id: str = Query("default")):
    try:
        return google_oauth.refresh_tenant_credentials(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/tenants/{tenant_id}/drive-config")
async def get_tenant_drive_config(tenant_id: str):
    redis_conn = get_redis()
    cfg = load_tenant_drive_config(redis_conn, tenant_id)
    if not cfg:
        default_input = (settings.drive_input_folder_id or "").strip()
        default_root = (settings.drive_root_folder_id or "").strip()
        if default_input and default_root:
            cfg = {
                "tenant_id": tenant_id,
                "drive_input_folder_id": default_input,
                "drive_root_folder_id": default_root,
                "drive_recibox_folder_id": None,
                "source": "default_env",
                "updated_at": None,
            }
        else:
            cfg = {
                "tenant_id": tenant_id,
                "drive_input_folder_id": None,
                "drive_root_folder_id": None,
                "drive_recibox_folder_id": None,
                "source": "not_configured",
                "updated_at": None,
            }
    else:
        cfg = {
            "tenant_id": cfg.tenant_id,
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }
    has_custom = load_tenant_drive_config(redis_conn, tenant_id) is not None
    return {
        "tenant_id": cfg["tenant_id"],
        "drive_input_folder_id": cfg["drive_input_folder_id"],
        "drive_root_folder_id": cfg["drive_root_folder_id"],
        "drive_recibox_folder_id": cfg["drive_recibox_folder_id"],
        "source": cfg["source"],
        "has_custom_config": has_custom,
        "updated_at": cfg["updated_at"],
    }


@router.put("/tenants/{tenant_id}/drive-config")
async def put_tenant_drive_config(tenant_id: str, payload: TenantDriveConfigPayload):
    redis_conn = get_redis()
    try:
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=payload.drive_input_folder_id,
            drive_root_folder_id=payload.drive_root_folder_id,
            drive_recibox_folder_id=payload.drive_recibox_folder_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Save failed: {exc}")

    set_tenant_disabled(redis_conn, tenant_id, False)
    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "drive_input_folder_id": cfg.drive_input_folder_id,
        "drive_root_folder_id": cfg.drive_root_folder_id,
        "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
        "source": cfg.source,
        "updated_at": cfg.updated_at,
    }


@router.delete("/tenants/{tenant_id}/drive-config")
async def delete_tenant_drive_config(tenant_id: str):
    redis_conn = get_redis()
    deleted = clear_tenant_drive_config(redis_conn, tenant_id)
    return {"status": "ok", "tenant_id": tenant_id, "deleted": deleted}


@router.get("/tenants/{tenant_id}/processing-preferences")
async def get_tenant_processing_preferences(tenant_id: str):
    redis_conn = get_redis()
    cfg = resolve_tenant_processing_preferences(redis_conn, tenant_id)
    has_custom = load_tenant_processing_preferences(redis_conn, tenant_id) is not None
    return {
        "tenant_id": cfg.tenant_id,
        "filename_format_mode": cfg.filename_format_mode,
        "filename_custom_format": {
            "part1": cfg.filename_custom_format.part1,
            "sep1": cfg.filename_custom_format.sep1,
            "part2": cfg.filename_custom_format.part2,
            "sep2": cfg.filename_custom_format.sep2,
            "part3": cfg.filename_custom_format.part3,
        },
        "employee_folder_number_mode": cfg.employee_folder_number_mode,
        "employee_folder_number_custom_part1": cfg.employee_folder_number_custom_part1,
        "employee_folder_number_custom_part2": cfg.employee_folder_number_custom_part2,
        "auto_create_missing_employee_folder": cfg.auto_create_missing_employee_folder,
        "source": cfg.source,
        "has_custom_config": has_custom,
        "updated_at": cfg.updated_at,
    }


@router.put("/tenants/{tenant_id}/processing-preferences")
async def put_tenant_processing_preferences(tenant_id: str, payload: ProcessingPreferencesPayload):
    redis_conn = get_redis()
    try:
        cfg = save_tenant_processing_preferences(
            redis_conn,
            tenant_id,
            filename_format_mode=payload.filename_format_mode,
            filename_custom_format=(
                payload.filename_custom_format.model_dump() if payload.filename_custom_format else None
            ),
            employee_folder_number_mode=payload.employee_folder_number_mode,
            employee_folder_number_custom_part1=payload.employee_folder_number_custom_part1,
            employee_folder_number_custom_part2=payload.employee_folder_number_custom_part2,
            auto_create_missing_employee_folder=payload.auto_create_missing_employee_folder,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Save failed: {exc}")

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "filename_format_mode": cfg.filename_format_mode,
        "filename_custom_format": {
            "part1": cfg.filename_custom_format.part1,
            "sep1": cfg.filename_custom_format.sep1,
            "part2": cfg.filename_custom_format.part2,
            "sep2": cfg.filename_custom_format.sep2,
            "part3": cfg.filename_custom_format.part3,
        },
        "employee_folder_number_mode": cfg.employee_folder_number_mode,
        "employee_folder_number_custom_part1": cfg.employee_folder_number_custom_part1,
        "employee_folder_number_custom_part2": cfg.employee_folder_number_custom_part2,
        "auto_create_missing_employee_folder": cfg.auto_create_missing_employee_folder,
        "source": cfg.source,
        "updated_at": cfg.updated_at,
    }


@router.delete("/tenants/{tenant_id}/processing-preferences")
async def delete_tenant_processing_preferences(tenant_id: str):
    redis_conn = get_redis()
    deleted = clear_tenant_processing_preferences(redis_conn, tenant_id)
    return {"status": "ok", "tenant_id": tenant_id, "deleted": deleted}
