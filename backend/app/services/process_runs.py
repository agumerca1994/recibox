from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from rq.job import Job

from app.db.postgres import get_postgres_conn
from app.queue import get_redis

VALID_PROCESS_STATES = {"running", "success", "error", "paused"}


@dataclass
class ProcessRun:
    job_id: str
    tenant_id: str
    processing_mode: str
    template_id: str | None
    template_name: str | None
    file_ids_count: int
    name: str
    status: str
    detail: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime
    paused_at: datetime | None


def _normalize_tenant_id(value: str | None) -> str:
    tenant_id = str(value or "").strip().lower()
    if not tenant_id:
        raise ValueError("tenant_id is required")
    return tenant_id


def _normalize_process_state(value: str | None) -> str:
    state = str(value or "").strip().lower()
    if state not in VALID_PROCESS_STATES:
        raise ValueError(f"status must be one of: {', '.join(sorted(VALID_PROCESS_STATES))}")
    return state


def _status_text(value: Any) -> str:
    if value is None:
        return ""
    raw = getattr(value, "value", value)
    text = str(raw).strip().lower()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _row_to_process_run(row: dict[str, Any]) -> ProcessRun:
    detail = row.get("detail")
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except Exception:
            detail = None
    return ProcessRun(
        job_id=str(row["job_id"]),
        tenant_id=str(row["tenant_id"]),
        processing_mode=str(row["processing_mode"]),
        template_id=row.get("template_id"),
        template_name=row.get("template_name"),
        file_ids_count=int(row.get("file_ids_count") or 0),
        name=str(row["name"]),
        status=str(row["status"]),
        detail=detail if isinstance(detail, dict) else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        paused_at=row.get("paused_at"),
    )


def init_process_runs_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS process_runs (
                  job_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  processing_mode TEXT NOT NULL,
                  template_id TEXT NULL,
                  template_name TEXT NULL,
                  file_ids_count INTEGER NOT NULL DEFAULT 0,
                  name TEXT NOT NULL,
                  status TEXT NOT NULL,
                  detail JSONB NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  paused_at TIMESTAMPTZ NULL
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_process_runs_tenant_created
                ON process_runs (tenant_id, created_at DESC)
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_process_runs_tenant_lower_created
                ON process_runs ((LOWER(tenant_id)), created_at DESC)
                """
            )
        conn.commit()


def serialize_job_status(job: Job) -> dict[str, Any]:
    duration_seconds = None
    if job.started_at:
        end = job.ended_at or None
        if end:
            duration_seconds = (end - job.started_at).total_seconds()
        else:
            active_reference = job.last_heartbeat or job.started_at
            duration_seconds = (active_reference - job.started_at).total_seconds()

    progress = job.meta.get("progress") if isinstance(getattr(job, "meta", None), dict) else None

    return _jsonable(
        {
            "job_id": job.id,
            "status": _status_text(job.get_status()),
            "result": job.result,
            "progress": progress if isinstance(progress, dict) else None,
            "created_at": job.created_at,
            "enqueued_at": job.enqueued_at,
            "started_at": job.started_at,
            "ended_at": job.ended_at,
            "duration_seconds": duration_seconds,
        }
    )


def derive_process_state(status: str | None, detail: dict[str, Any] | None) -> str:
    value = _status_text(status)
    result = detail.get("result") if isinstance(detail, dict) else None

    if value == "finished" and isinstance(result, dict):
        flow_status = str(result.get("status", "")).strip().lower()
        error_count = result.get("error")
        if flow_status in {"partial", "error"}:
            return "error"
        if isinstance(error_count, int) and error_count > 0:
            return "error"
        return "success"

    if value == "finished":
        return "success"
    if value in {"queued", "started", "deferred", "scheduled"}:
        return "running"
    if value in {"canceled", "cancelled", "stopped", "stopping"}:
        return "paused"
    return "error"


def upsert_process_run(
    *,
    job_id: str,
    tenant_id: str,
    processing_mode: str,
    name: str,
    status: str,
    template_id: str | None = None,
    template_name: str | None = None,
    file_ids_count: int = 0,
    detail: dict[str, Any] | None = None,
    paused_at: datetime | None = None,
) -> ProcessRun:
    normalized_tenant_id = _normalize_tenant_id(tenant_id)
    normalized_status = _normalize_process_state(status)
    normalized_name = str(name or "").strip()
    if not normalized_name:
        raise ValueError("name is required")

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                INSERT INTO process_runs (
                  job_id,
                  tenant_id,
                  processing_mode,
                  template_id,
                  template_name,
                  file_ids_count,
                  name,
                  status,
                  detail,
                  paused_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (job_id) DO UPDATE SET
                  tenant_id = EXCLUDED.tenant_id,
                  processing_mode = EXCLUDED.processing_mode,
                  template_id = EXCLUDED.template_id,
                  template_name = EXCLUDED.template_name,
                  file_ids_count = EXCLUDED.file_ids_count,
                  name = EXCLUDED.name,
                  status = EXCLUDED.status,
                  detail = EXCLUDED.detail,
                  paused_at = EXCLUDED.paused_at,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    str(job_id).strip(),
                    normalized_tenant_id,
                    str(processing_mode or "").strip() or "template",
                    str(template_id).strip() if template_id else None,
                    str(template_name).strip() if template_name else None,
                    max(int(file_ids_count or 0), 0),
                    normalized_name,
                    normalized_status,
                    Jsonb(_jsonable(detail)) if detail is not None else None,
                    paused_at,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise RuntimeError("Failed to persist process run")
    return _row_to_process_run(row)


def get_process_run(job_id: str) -> ProcessRun | None:
    normalized_job_id = str(job_id or "").strip()
    if not normalized_job_id:
        return None
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT *
                FROM process_runs
                WHERE job_id = %s
                """,
                (normalized_job_id,),
            )
            row = cur.fetchone()
    return _row_to_process_run(row) if row else None


def list_process_runs(tenant_id: str, *, limit: int = 10) -> list[ProcessRun]:
    normalized_tenant_id = _normalize_tenant_id(tenant_id)
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT *
                FROM process_runs
                WHERE LOWER(tenant_id) = LOWER(%s)
                ORDER BY
                  CASE WHEN status = 'running' THEN 0 ELSE 1 END,
                  created_at DESC
                LIMIT %s
                """,
                (normalized_tenant_id, max(1, min(int(limit), 10))),
            )
            rows = cur.fetchall()
    return [_row_to_process_run(row) for row in rows]


def sync_process_run(job_id: str) -> ProcessRun | None:
    record = get_process_run(job_id)
    if not record or record.status == "paused":
        return record

    try:
        job = Job.fetch(record.job_id, connection=get_redis())
    except Exception:
        return record

    detail = serialize_job_status(job)
    next_status = derive_process_state(job.get_status(), detail)
    return upsert_process_run(
        job_id=record.job_id,
        tenant_id=record.tenant_id,
        processing_mode=record.processing_mode,
        template_id=record.template_id,
        template_name=record.template_name,
        file_ids_count=record.file_ids_count,
        name=record.name,
        status=next_status,
        detail=detail,
        paused_at=record.paused_at,
    )


def list_recent_process_runs(tenant_id: str, *, limit: int = 10) -> list[ProcessRun]:
    records = list_process_runs(tenant_id, limit=limit)
    if not records:
        return []

    synced_records: list[ProcessRun] = []
    for record in records:
        if record.status != "paused":
            synced_records.append(sync_process_run(record.job_id) or record)
        else:
            synced_records.append(record)

    return sorted(
        synced_records,
        key=lambda item: (
            0 if item.status == "running" else 1,
            -item.created_at.timestamp(),
        ),
        reverse=False,
    )[: max(1, min(int(limit), 10))]


def mark_process_run_paused(job_id: str, *, detail: dict[str, Any] | None = None) -> ProcessRun | None:
    record = get_process_run(job_id)
    if not record:
        return None

    payload = detail if isinstance(detail, dict) else record.detail
    return upsert_process_run(
        job_id=record.job_id,
        tenant_id=record.tenant_id,
        processing_mode=record.processing_mode,
        template_id=record.template_id,
        template_name=record.template_name,
        file_ids_count=record.file_ids_count,
        name=record.name,
        status="paused",
        detail=payload,
        paused_at=datetime.now(timezone.utc),
    )


def serialize_process_run(record: ProcessRun) -> dict[str, Any]:
    return {
        "id": record.job_id,
        "job_id": record.job_id,
        "tenant_id": record.tenant_id,
        "processing_mode": record.processing_mode,
        "template_id": record.template_id,
        "template_name": record.template_name,
        "file_ids_count": record.file_ids_count,
        "name": record.name,
        "state": record.status,
        "detail": _jsonable(record.detail) if record.detail is not None else None,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
        "paused_at": record.paused_at.isoformat() if record.paused_at else None,
    }
