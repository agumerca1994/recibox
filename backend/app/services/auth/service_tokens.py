from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from typing import Iterable
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.core.config import settings
from app.db.postgres import get_postgres_conn


SERVICE_TOKEN_SCOPES = {
    "drive:read",
    "drive:write",
    "templates:read",
    "templates:write",
    "reports:read",
    "reports:write",
    "jobs:run",
    "jobs:stop",
}


@dataclass
class ServiceTokenRecord:
    token_id: str
    tenant_id: str
    name: str
    token_hash: str
    scopes: list[str]
    created_by_uid: str
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
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


def _normalize_scopes(scopes: Iterable[str] | None) -> list[str]:
    normalized = sorted(
        {
            str(scope or "").strip().lower()
            for scope in (scopes or [])
            if str(scope or "").strip()
        }
    )
    if not normalized:
        raise ValueError("At least one scope is required")
    invalid = [scope for scope in normalized if scope not in SERVICE_TOKEN_SCOPES]
    if invalid:
        raise ValueError("Invalid service token scopes: %s" % ", ".join(sorted(invalid)))
    return normalized


def _hash_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _row_to_service_token(row: dict) -> ServiceTokenRecord:
    scopes = row.get("scopes")
    return ServiceTokenRecord(
        token_id=str(row["token_id"]),
        tenant_id=str(row["tenant_id"]),
        name=str(row["name"]),
        token_hash=str(row["token_hash"]),
        scopes=[str(item) for item in (scopes or []) if str(item or "").strip()],
        created_by_uid=str(row["created_by_uid"]),
        expires_at=row.get("expires_at"),
        revoked_at=row.get("revoked_at"),
        last_used_at=row.get("last_used_at"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def init_service_tokens_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS service_tokens (
                  token_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  token_hash TEXT NOT NULL UNIQUE,
                  scopes JSONB NOT NULL,
                  created_by_uid TEXT NOT NULL,
                  expires_at TIMESTAMPTZ NULL,
                  revoked_at TIMESTAMPTZ NULL,
                  last_used_at TIMESTAMPTZ NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_service_tokens_tenant_created
                ON service_tokens ((LOWER(tenant_id)), created_at DESC)
                """
            )
        conn.commit()


def list_service_tokens(*, tenant_id: str) -> list[ServiceTokenRecord]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT *
                FROM service_tokens
                WHERE LOWER(tenant_id) = %s
                ORDER BY created_at DESC
                """,
                (normalized_tenant,),
            )
            rows = cur.fetchall()
    return [_row_to_service_token(row) for row in rows]


def create_service_token(
    *,
    tenant_id: str,
    name: str,
    scopes: Iterable[str],
    created_by_uid: str,
    expires_in_days: int = 90,
) -> tuple[ServiceTokenRecord, str]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_creator = _normalize_text(created_by_uid, "created_by_uid", required=True)
    normalized_scopes = _normalize_scopes(scopes)
    if expires_in_days < 1 or expires_in_days > 365:
        raise ValueError("expires_in_days must be between 1 and 365")

    assert normalized_name is not None
    assert normalized_creator is not None
    token_id = str(uuid4())
    secret = secrets.token_urlsafe(32)
    plain_token = f"{settings.service_token_prefix}{secret}"
    token_hash = _hash_token(plain_token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=int(expires_in_days))

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                INSERT INTO service_tokens (
                  token_id,
                  tenant_id,
                  name,
                  token_hash,
                  scopes,
                  created_by_uid,
                  expires_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    token_id,
                    normalized_tenant,
                    normalized_name,
                    token_hash,
                    Jsonb(normalized_scopes),
                    normalized_creator,
                    expires_at,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise RuntimeError("Failed to create service token")
    return _row_to_service_token(row), plain_token


def revoke_service_token(*, tenant_id: str, token_id: str) -> ServiceTokenRecord | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_token_id = _normalize_text(token_id, "token_id", required=True)
    assert normalized_token_id is not None

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                UPDATE service_tokens
                SET revoked_at = COALESCE(revoked_at, NOW()),
                    updated_at = NOW()
                WHERE LOWER(tenant_id) = %s AND token_id = %s
                RETURNING *
                """,
                (normalized_tenant, normalized_token_id),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_service_token(row) if row else None


def verify_service_token(token: str) -> ServiceTokenRecord | None:
    normalized_token = str(token or "").strip()
    if not normalized_token:
        return None
    token_hash = _hash_token(normalized_token)
    now = datetime.now(timezone.utc)

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT *
                FROM service_tokens
                WHERE token_hash = %s
                """,
                (token_hash,),
            )
            row = cur.fetchone()
            if not row:
                return None
            record = _row_to_service_token(row)
            if record.revoked_at is not None:
                return None
            if record.expires_at is not None and record.expires_at <= now:
                return None
            cur.execute(
                """
                UPDATE service_tokens
                SET last_used_at = NOW(),
                    updated_at = NOW()
                WHERE token_id = %s
                """,
                (record.token_id,),
            )
        conn.commit()
    return record
