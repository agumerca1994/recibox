from __future__ import annotations

from app.queue import get_redis
from app.services.storage import gdrive
from app.services.tenants.drive_config import resolve_tenant_drive_config


def _normalize_group_folder_name(name: str) -> str:
    normalized = " ".join(str(name or "").strip().split())
    if not normalized:
        raise ValueError("Group name is required to sync Drive folder")
    return normalized


def _resolve_recibox_folder_id(*, tenant_id: str) -> str:
    redis_conn = get_redis()
    cfg = resolve_tenant_drive_config(redis_conn, tenant_id)
    folder_id = str(cfg.recibox_folder_id or "").strip()
    if not folder_id:
        raise RuntimeError(f"RECIBOX folder is not configured for tenant '{tenant_id}'")
    return folder_id


def ensure_template_group_drive_folder(
    *,
    tenant_id: str,
    group_name: str,
    drive_folder_id: str | None = None,
) -> dict:
    target_name = _normalize_group_folder_name(group_name)
    recibox_folder_id = _resolve_recibox_folder_id(tenant_id=tenant_id)
    normalized_folder_id = str(drive_folder_id or "").strip()

    if normalized_folder_id:
        try:
            metadata = gdrive.get_file_metadata(
                normalized_folder_id,
                tenant_id=tenant_id,
                fields="id, name, mimeType, parents",
            )
        except Exception:
            metadata = None
        if metadata and metadata.get("mimeType") == "application/vnd.google-apps.folder":
            current_name = str(metadata.get("name", "")).strip()
            current_parents = [
                str(parent_id).strip()
                for parent_id in metadata.get("parents", [])
                if str(parent_id).strip()
            ]
            add_parent = recibox_folder_id if recibox_folder_id not in current_parents else None
            remove_parents = ",".join(parent_id for parent_id in current_parents if parent_id != recibox_folder_id) or None
            if current_name == target_name and add_parent is None and remove_parents is None:
                return {
                    "id": str(metadata.get("id", "")).strip(),
                    "name": current_name,
                    "parents": current_parents,
                }
            return gdrive.update_file_metadata(
                normalized_folder_id,
                tenant_id=tenant_id,
                new_name=target_name if current_name != target_name else None,
                add_parents=add_parent,
                remove_parents=remove_parents,
            )

    existing = gdrive.find_folder_by_name(recibox_folder_id, target_name, tenant_id=tenant_id)
    if existing:
        return existing
    return gdrive.create_folder(recibox_folder_id, target_name, tenant_id=tenant_id)
