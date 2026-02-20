from __future__ import annotations

import argparse
from pathlib import Path

from app.core.config import settings
from app.services.pdf.extractor import extract_text_from_pdf, parse_fields
from app.services.processing.classifier import classify
from app.services.processing.results import ProcessResult, write_result
from app.services.storage import gdrive
from app.services.storage.gdrive_ops import (
    ensure_employee_folder,
    ensure_year_folder,
    move_and_rename_file,
)


def _process_one(file_meta: dict) -> ProcessResult:
    file_id = file_meta["id"]
    file_name = file_meta.get("name", "")
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"{file_id}.pdf"

    try:
        gdrive.download_file(file_id, str(local_path))
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
    target = classify(info)

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
        emp_folder = ensure_employee_folder(settings.drive_root_folder_id, target["folder_employee"])
        year_folder = ensure_year_folder(emp_folder["id"], target["folder_year"])
        move_and_rename_file(file_id, year_folder["id"], target["new_filename"])
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


def main() -> int:
    parser = argparse.ArgumentParser(description="RECIBOX full flow test (sequential)")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    try:
        files = list(
            gdrive.list_files_in_folder(
                settings.drive_input_folder_id, query_extra="mimeType = 'application/pdf'"
            )
        )
    except Exception as exc:
        print("ERROR: Failed to list files from Drive INPUT folder.")
        print("DETAILS:", exc)
        return 1

    if not files:
        print("No PDFs found in INPUT folder.")
        return 0

    total = min(len(files), args.limit)
    print(f"Found {len(files)} PDFs. Processing {total}...")

    ok = 0
    err = 0
    for f in files[:total]:
        result = _process_one(f)
        write_result(result, settings.results_log_path)
        if result.status == "ok":
            ok += 1
            print("OK:", result.file_id, result.message)
        else:
            err += 1
            print("ERROR:", result.file_id, result.message)
            if result.error:
                print("DETAILS:", result.error)

    print(f"Done. ok={ok} error={err} log={settings.results_log_path}")
    return 0 if err == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
