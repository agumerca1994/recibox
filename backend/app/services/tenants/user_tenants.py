from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from app.db.postgres import get_postgres_conn


@dataclass
class UserTenant:
    uid: str
    email: str | None
    tenant_id: str


def _new_tenant_id() -> str:
    return f"tenant-{uuid4()}"


def init_user_tenants_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_user_tenants (
                  uid TEXT PRIMARY KEY,
                  email TEXT NULL,
                  tenant_id TEXT NOT NULL UNIQUE,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        conn.commit()


def resolve_or_create_user_tenant(uid: str, email: str | None) -> UserTenant:
    normalized_uid = uid.strip()
    if not normalized_uid:
        raise ValueError("uid is required")
    normalized_email = (email or "").strip() or None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT uid, email, tenant_id FROM auth_user_tenants WHERE uid = %s", (normalized_uid,))
            row = cur.fetchone()
            if row:
                current_uid, current_email, current_tenant_id = row
                if normalized_email and current_email != normalized_email:
                    cur.execute(
                        "UPDATE auth_user_tenants SET email = %s, updated_at = NOW() WHERE uid = %s",
                        (normalized_email, normalized_uid),
                    )
                    conn.commit()
                    return UserTenant(uid=current_uid, email=normalized_email, tenant_id=current_tenant_id)
                return UserTenant(uid=current_uid, email=current_email, tenant_id=current_tenant_id)

            tenant_id = _new_tenant_id()
            cur.execute(
                """
                INSERT INTO auth_user_tenants (uid, email, tenant_id)
                VALUES (%s, %s, %s)
                RETURNING uid, email, tenant_id
                """,
                (normalized_uid, normalized_email, tenant_id),
            )
            created_uid, created_email, created_tenant_id = cur.fetchone()
        conn.commit()
    return UserTenant(uid=created_uid, email=created_email, tenant_id=created_tenant_id)

