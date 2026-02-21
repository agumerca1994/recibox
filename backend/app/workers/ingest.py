from __future__ import annotations

from app.core.config import settings
from app.services.storage.gdrive import (
    download_file,
    ensure_folder,
    list_new_files,
    move_and_rename,
)
from app.services.processing.processor import process_downloaded_file


def run_poll_cycle() -> None:
    root_id = (settings.drive_root_folder_id or "").strip()
    if not root_id:
        raise RuntimeError("DRIVE_ROOT_FOLDER_ID is not configured")
    for f in list_new_files():
        file_id = f["id"]
        download_file(file_id, f"{settings.local_download_dir}/{file_id}.pdf")
        result = process_downloaded_file(file_id, settings.local_download_dir)
        target = result["target"]

        employee_folder = ensure_folder(root_id, target["folder_employee"])
        year_folder = ensure_folder(employee_folder["id"], target["folder_year"])

        move_and_rename(file_id, year_folder["id"], target["new_filename"])
