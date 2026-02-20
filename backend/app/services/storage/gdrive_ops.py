from __future__ import annotations

import re
from typing import Iterable

from app.services.storage import gdrive


def _normalize(value: str) -> str:
    return " ".join(value.strip().upper().split())


def _list_folders(parent_id: str, *, tenant_id: str | None = None) -> Iterable[dict]:
    query = "mimeType = 'application/vnd.google-apps.folder'"
    return gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id)


def find_employee_folder(root_id: str, empleado: str, *, tenant_id: str | None = None) -> dict | None:
    target = _normalize(empleado)
    for folder in _list_folders(root_id, tenant_id=tenant_id):
        name = folder.get("name", "")
        if _normalize(name).endswith(target):
            return folder
    return None


def list_employee_folders(root_id: str, *, tenant_id: str | None = None) -> list[dict]:
    return list(_list_folders(root_id, tenant_id=tenant_id))


def list_year_folders(employee_folder_id: str, *, tenant_id: str | None = None) -> list[dict]:
    return list(_list_folders(employee_folder_id, tenant_id=tenant_id))


def _next_employee_index(root_id: str, *, tenant_id: str | None = None) -> int:
    max_n = 0
    for folder in _list_folders(root_id, tenant_id=tenant_id):
        name = folder.get("name", "")
        m = re.match(r"^#(\d+)\s+", name.strip())
        if m:
            try:
                max_n = max(max_n, int(m.group(1)))
            except ValueError:
                continue
    return max_n + 1


def ensure_employee_folder(root_id: str, empleado: str, *, tenant_id: str | None = None) -> dict:
    existing = find_employee_folder(root_id, empleado, tenant_id=tenant_id)
    if existing:
        return existing

    idx = _next_employee_index(root_id, tenant_id=tenant_id)
    folder_name = f"#{idx} {empleado}"
    return gdrive.create_folder(root_id, folder_name, tenant_id=tenant_id)


def ensure_year_folder(employee_folder_id: str, anio: str, *, tenant_id: str | None = None) -> dict:
    return gdrive.ensure_folder(employee_folder_id, anio, tenant_id=tenant_id)


def move_and_rename_file(
    file_id: str, folder_id: str, new_name: str, *, tenant_id: str | None = None
) -> dict:
    return gdrive.move_and_rename(file_id, folder_id, new_name, tenant_id=tenant_id)
