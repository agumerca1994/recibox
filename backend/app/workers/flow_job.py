from __future__ import annotations

from app.core.config import settings
from app.queue import get_redis
from app.services.processing.results import ProcessResult, write_result
from app.services.storage import gdrive
from app.services.pdf.extractor import extract_text_from_pdf, parse_fields
from app.services.processing.classifier import classify
from app.services.storage.gdrive_ops import (
    ensure_employee_folder,
    ensure_year_folder,
    move_and_rename_file,
)
from app.services.tenants.drive_config import resolve_tenant_drive_config
from app.services.tenants.processing_preferences import resolve_tenant_processing_preferences
from pathlib import Path


def _process_one(
    file_meta: dict,
    *,
    tenant_id: str,
    drive_root_folder_id: str,
    filename_format_mode: str,
    filename_custom_format: dict | None,
    employee_folder_number_mode: str,
    employee_folder_number_custom_part1: str,
    employee_folder_number_custom_part2: str,
    auto_create_missing_employee_folder: bool,
) -> ProcessResult:
    file_id = file_meta["id"]
    file_name = file_meta.get("name", "")
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"{file_id}.pdf"

    try:
        gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
    except Exception as exc:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Download failed",
            error=str(exc),
        )

    try:
        text = extract_text_from_pdf(str(local_path))
    except Exception as exc:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Extraction failed",
            error=str(exc),
        )

    if not text.strip():
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Extracted text is empty",
        )

    info = parse_fields(text)
    target = classify(
        info,
        filename_format_mode=filename_format_mode,
        filename_custom_format=filename_custom_format,
        employee_folder_number_mode=employee_folder_number_mode,
        employee_folder_number_custom_part1=employee_folder_number_custom_part1,
        employee_folder_number_custom_part2=employee_folder_number_custom_part2,
    )

    missing = []
    if not info.empleado:
        missing.append("empleado")
    if not info.mes:
        missing.append("mes")
    if not info.anio:
        missing.append("anio")

    if missing:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message=f"Parse incomplete (missing: {', '.join(missing)})",
            info=info,
            target=target,
        )

    try:
        emp_folder = ensure_employee_folder(
            drive_root_folder_id,
            target["folder_employee"],
            tenant_id=tenant_id,
            number_mode=employee_folder_number_mode,
            custom_part1=employee_folder_number_custom_part1,
            custom_part2=employee_folder_number_custom_part2,
            create_if_missing=auto_create_missing_employee_folder,
        )
        if not emp_folder:
            return ProcessResult(
                file_id=file_id,
                status="error",
                message="Carpeta de colaborador inexistente",
                info=info,
                target=target,
            )
        year_folder = ensure_year_folder(
            emp_folder["id"],
            target["folder_year"],
            tenant_id=tenant_id,
        )
        move_and_rename_file(
            file_id,
            year_folder["id"],
            target["new_filename"],
            tenant_id=tenant_id,
        )
    except Exception as exc:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Drive move/rename failed",
            info=info,
            target=target,
            error=str(exc),
        )
    finally:
        try:
            local_path.unlink(missing_ok=True)
        except Exception:
            pass

    return ProcessResult(
        file_id=file_id,
        status="ok",
        message=f"Processed and moved: {file_name}",
        info=info,
        target=target,
    )


def run_flow(tenant_id: str = "default", limit: int = 50) -> dict:
    lock_key = f"recibox:lock:{tenant_id}"
    redis_conn = get_redis()
    try:
        cfg = resolve_tenant_drive_config(redis_conn, tenant_id)
        preferences = resolve_tenant_processing_preferences(redis_conn, tenant_id)
    except Exception as exc:
        return {"status": "error", "message": f"Tenant config failed: {exc}"}
    try:
        files = list(
            gdrive.list_files_in_folder(
                cfg.drive_input_folder_id,
                query_extra="mimeType = 'application/pdf'",
                tenant_id=tenant_id,
            )
        )
    except Exception as exc:
        return {"status": "error", "message": f"List failed: {exc}"}

    try:
        if not files:
            return {"status": "ok", "message": "No PDFs found", "processed": 0}

        total = min(len(files), limit)
        ok = 0
        err = 0
        for f in files[:total]:
            result = _process_one(
                f,
                tenant_id=tenant_id,
                drive_root_folder_id=cfg.recibox_folder_id,
                filename_format_mode=preferences.filename_format_mode,
                filename_custom_format=preferences.filename_custom_format.__dict__,
                employee_folder_number_mode=preferences.employee_folder_number_mode,
                employee_folder_number_custom_part1=preferences.employee_folder_number_custom_part1,
                employee_folder_number_custom_part2=preferences.employee_folder_number_custom_part2,
                auto_create_missing_employee_folder=preferences.auto_create_missing_employee_folder,
            )
            write_result(result, settings.results_log_path)
            if result.status == "ok":
                ok += 1
            else:
                err += 1

        return {
            "status": "ok" if err == 0 else "partial",
            "processed": total,
            "ok": ok,
            "error": err,
            "log": settings.results_log_path,
        }
    finally:
        try:
            redis_conn.delete(lock_key)
        except Exception:
            pass
