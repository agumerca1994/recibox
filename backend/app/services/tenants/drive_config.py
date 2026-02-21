from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from redis import Redis

from app.core.config import settings


@dataclass
class TenantDriveConfig:
    tenant_id: str
    drive_input_folder_id: str
    drive_root_folder_id: str
    source: str
    updated_at: str | None = None


def _key(tenant_id: str) -> str:
    return f"recibox:tenant:{tenant_id}:drive_config"


def _disabled_key(tenant_id: str) -> str:
    return f"recibox:tenant:{tenant_id}:disabled"


def set_tenant_disabled(redis_conn: Redis, tenant_id: str, disabled: bool) -> None:
    if disabled:
        redis_conn.set(_disabled_key(tenant_id), "1")
    else:
        redis_conn.delete(_disabled_key(tenant_id))


def is_tenant_disabled(redis_conn: Redis, tenant_id: str) -> bool:
    return bool(redis_conn.get(_disabled_key(tenant_id)))


def load_tenant_drive_config(redis_conn: Redis, tenant_id: str) -> TenantDriveConfig | None:
    raw = redis_conn.get(_key(tenant_id))
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"Invalid tenant drive config for '{tenant_id}': {exc}") from exc

    input_id = str(payload.get("drive_input_folder_id", "")).strip()
    root_id = str(payload.get("drive_root_folder_id", "")).strip()
    if not input_id or not root_id:
        return None
    return TenantDriveConfig(
        tenant_id=tenant_id,
        drive_input_folder_id=input_id,
        drive_root_folder_id=root_id,
        source="tenant",
        updated_at=payload.get("updated_at"),
    )


def save_tenant_drive_config(
    redis_conn: Redis,
    tenant_id: str,
    *,
    drive_input_folder_id: str,
    drive_root_folder_id: str,
) -> TenantDriveConfig:
    input_id = drive_input_folder_id.strip()
    root_id = drive_root_folder_id.strip()
    if not input_id:
        raise ValueError("drive_input_folder_id is required")
    if not root_id:
        raise ValueError("drive_root_folder_id is required")

    cfg = TenantDriveConfig(
        tenant_id=tenant_id,
        drive_input_folder_id=input_id,
        drive_root_folder_id=root_id,
        source="tenant",
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    redis_conn.set(_key(tenant_id), json.dumps(asdict(cfg)))
    return cfg


def clear_tenant_drive_config(redis_conn: Redis, tenant_id: str) -> bool:
    return bool(redis_conn.delete(_key(tenant_id)))


def resolve_tenant_drive_config(redis_conn: Redis, tenant_id: str) -> TenantDriveConfig:
    cfg = load_tenant_drive_config(redis_conn, tenant_id)
    if cfg:
        return cfg
    default_input = (settings.drive_input_folder_id or "").strip()
    default_root = (settings.drive_root_folder_id or "").strip()
    if not default_input or not default_root:
        raise RuntimeError(
            f"Tenant '{tenant_id}' drive config is missing. "
            "Configure it via PUT /tenants/{tenant_id}/drive-config."
        )
    return TenantDriveConfig(
        tenant_id=tenant_id,
        drive_input_folder_id=default_input,
        drive_root_folder_id=default_root,
        source="default_env",
    )
