from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from app.db.postgres import get_postgres_conn


@dataclass
class TemplateGroup:
    group_id: str
    tenant_id: str
    name: str
    drive_folder_id: str
    created_at: datetime
    updated_at: datetime


def _normalize_text(value: str | None, field: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if required and not normalized:
        raise ValueError(f"{field} is required")
    return normalized or None


def _normalize_tenant_id(value: str | None) -> str:
    normalized = _normalize_text(value, "tenant_id", required=True)
    assert normalized is not None
    return normalized.lower()


def init_template_groups_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS template_groups (
                  group_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  drive_folder_id TEXT NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_template_groups_tenant_name_unique
                ON template_groups ((LOWER(tenant_id)), LOWER(name))
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_template_groups_tenant_drive_folder_unique
                ON template_groups ((LOWER(tenant_id)), drive_folder_id)
                """
            )
        conn.commit()


def _row_to_group(row: tuple) -> TemplateGroup:
    return TemplateGroup(
        group_id=row[0],
        tenant_id=row[1],
        name=row[2],
        drive_folder_id=row[3],
        created_at=row[4],
        updated_at=row[5],
    )


def ensure_template_group_name_available(
    *,
    tenant_id: str,
    name: str,
) -> None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_name = _normalize_text(name, "name", required=True)
    assert normalized_name is not None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1
                FROM template_groups
                WHERE LOWER(tenant_id) = %s
                  AND LOWER(name) = LOWER(%s)
                LIMIT 1
                """,
                (normalized_tenant, normalized_name),
            )
            if cur.fetchone():
                raise ValueError(f"Template group '{normalized_name}' already exists")


def list_template_groups(*, tenant_id: str) -> list[TemplateGroup]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT group_id, tenant_id, name, drive_folder_id, created_at, updated_at
                FROM template_groups
                WHERE LOWER(tenant_id) = %s
                ORDER BY name ASC, created_at ASC
                """,
                (normalized_tenant,),
            )
            rows = cur.fetchall()
    return [_row_to_group(row) for row in rows]


def get_template_group(*, tenant_id: str, group_id: str) -> TemplateGroup | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_group_id = _normalize_text(group_id, "group_id", required=True)
    assert normalized_group_id is not None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT group_id, tenant_id, name, drive_folder_id, created_at, updated_at
                FROM template_groups
                WHERE LOWER(tenant_id) = %s AND group_id = %s
                """,
                (normalized_tenant, normalized_group_id),
            )
            row = cur.fetchone()
    return _row_to_group(row) if row else None


def get_template_groups_map(*, tenant_id: str, group_ids: list[str]) -> dict[str, TemplateGroup]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_group_ids = [
        group_id
        for group_id in (_normalize_text(item, "group_id") for item in group_ids)
        if group_id is not None
    ]
    if not normalized_group_ids:
        return {}

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT group_id, tenant_id, name, drive_folder_id, created_at, updated_at
                FROM template_groups
                WHERE LOWER(tenant_id) = %s
                  AND group_id = ANY(%s::text[])
                ORDER BY name ASC
                """,
                (normalized_tenant, normalized_group_ids),
            )
            rows = cur.fetchall()
    groups = [_row_to_group(row) for row in rows]
    return {group.group_id: group for group in groups}


def create_template_group(
    *,
    tenant_id: str,
    name: str,
    drive_folder_id: str,
) -> TemplateGroup:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_drive_folder_id = _normalize_text(drive_folder_id, "drive_folder_id", required=True)
    assert normalized_name is not None
    assert normalized_drive_folder_id is not None

    ensure_template_group_name_available(
        tenant_id=normalized_tenant,
        name=normalized_name,
    )

    group_id = str(uuid.uuid4())
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO template_groups (
                  group_id, tenant_id, name, drive_folder_id
                )
                VALUES (%s, %s, %s, %s)
                RETURNING group_id, tenant_id, name, drive_folder_id, created_at, updated_at
                """,
                (
                    group_id,
                    normalized_tenant,
                    normalized_name,
                    normalized_drive_folder_id,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_group(row)


def update_template_group_drive_folder_id(
    *,
    tenant_id: str,
    group_id: str,
    drive_folder_id: str,
) -> TemplateGroup | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_group_id = _normalize_text(group_id, "group_id", required=True)
    normalized_drive_folder_id = _normalize_text(drive_folder_id, "drive_folder_id", required=True)
    assert normalized_group_id is not None
    assert normalized_drive_folder_id is not None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE template_groups
                SET
                  drive_folder_id = %s,
                  updated_at = NOW()
                WHERE LOWER(tenant_id) = %s AND group_id = %s
                RETURNING group_id, tenant_id, name, drive_folder_id, created_at, updated_at
                """,
                (
                    normalized_drive_folder_id,
                    normalized_tenant,
                    normalized_group_id,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_group(row) if row else None
