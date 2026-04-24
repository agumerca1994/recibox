from __future__ import annotations

import csv
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from rq import get_current_job
from rq.job import Job

from app.core.config import settings
from app.db.postgres import get_postgres_conn
from app.queue import get_redis
from app.services.process_runs import serialize_job_status
from app.services.storage import gdrive
from app.services.templates.processor import extract_template_value_map_from_local_pdf
from app.services.templates.classification_rules import get_classification_rule
from app.services.templates.store import get_document_template, list_document_templates, resolve_template_mode
from app.services.templates.groups import get_template_group

VALID_REPORT_OUTPUT_FORMATS = {"csv", "xlsx"}
VALID_REPORT_COLUMN_SOURCE_TYPES = {"system", "template_field", "composite"}
VALID_REPORT_COLUMN_VALUE_TYPES = {"string", "number", "date"}
VALID_REPORT_RUN_STATES = {"running", "success", "error"}
VALID_CSV_DELIMITERS = {";", ","}
VALID_SYSTEM_COLUMN_KEYS = {"file_name", "relative_path", "template_name", "processed_at"}
VALID_REPORT_FORMAT_PART_TYPES = {"text", "space", "field"}


def _status_text(value: Any) -> str:
    if value is None:
        return ""
    raw = getattr(value, "value", value)
    text = str(raw).strip().lower()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _update_current_job_progress(
    *,
    processed: int,
    total: int,
    ok: int,
    error: int,
    status: str,
    message: str,
) -> None:
    try:
        job = get_current_job()
    except Exception:
        job = None
    if job is None:
        return
    try:
        job.meta["progress"] = {
            "processed": max(int(processed or 0), 0),
            "total": max(int(total or 0), 0),
            "ok": max(int(ok or 0), 0),
            "error": max(int(error or 0), 0),
            "status": str(status or "").strip() or "running",
            "message": str(message or "").strip() or None,
        }
        job.save_meta()
    except Exception:
        return


@dataclass
class ReportLayout:
    report_id: str
    tenant_id: str
    name: str
    description: str | None
    default_group_id: str
    default_output_format: str
    csv_delimiter: str
    columns: list[dict[str, Any]]
    is_active: bool
    created_at: datetime
    updated_at: datetime


@dataclass
class ReportRun:
    report_run_id: str
    job_id: str
    report_id: str | None
    report_name: str | None
    tenant_id: str
    group_id: str
    status: str
    output_format: str
    csv_delimiter: str
    selected_files: list[dict[str, Any]]
    columns_snapshot: list[dict[str, Any]]
    artifact_path: str | None
    artifact_filename: str | None
    detail: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _normalize_text(value: object, field: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if required and not normalized:
        raise ValueError(f"{field} is required")
    return normalized or None


def _normalize_tenant_id(value: str | None) -> str:
    normalized = _normalize_text(value, "tenant_id", required=True)
    assert normalized is not None
    return normalized.lower()


def _normalize_output_format(value: object) -> str:
    normalized = str(value or "").strip().lower() or "csv"
    if normalized not in VALID_REPORT_OUTPUT_FORMATS:
        raise ValueError("output_format must be 'csv' or 'xlsx'")
    return normalized


def _normalize_csv_delimiter(value: object | None) -> str:
    normalized = str(value or ";").strip() or ";"
    if normalized not in VALID_CSV_DELIMITERS:
        raise ValueError("csv_delimiter must be ';' or ','")
    return normalized


def _normalize_report_run_state(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in VALID_REPORT_RUN_STATES:
        raise ValueError("status must be one of: error, running, success")
    return normalized


def _normalize_column_value_type(value: object) -> str:
    normalized = str(value or "").strip().lower() or "string"
    if normalized not in VALID_REPORT_COLUMN_VALUE_TYPES:
        raise ValueError("column.value_type must be one of: string, number, date")
    return normalized


def _normalize_column_source_type(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in VALID_REPORT_COLUMN_SOURCE_TYPES:
        raise ValueError("column.source_type must be 'system', 'template_field' or 'composite'")
    return normalized


def normalize_report_run_options(*, output_format: object, csv_delimiter: object | None) -> tuple[str, str]:
    return _normalize_output_format(output_format), _normalize_csv_delimiter(csv_delimiter)


def _parse_report_format_parts(raw_parts: object, column_index: int) -> list[dict[str, Any]]:
    if not isinstance(raw_parts, list) or not raw_parts:
        raise ValueError(f"columns[{column_index}].format_parts must include at least one item")

    normalized_parts: list[dict[str, Any]] = []
    for part_index, raw_part in enumerate(raw_parts):
        if not isinstance(raw_part, dict):
            raise ValueError(f"columns[{column_index}].format_parts[{part_index}] must be an object")

        part_type = str(raw_part.get("part_type") or "").strip().lower()
        if part_type not in VALID_REPORT_FORMAT_PART_TYPES:
            raise ValueError(
                "columns[%d].format_parts[%d].part_type must be one of: %s"
                % (column_index, part_index, ", ".join(sorted(VALID_REPORT_FORMAT_PART_TYPES)))
            )

        part_id = _normalize_text(
            raw_part.get("part_id"),
            f"columns[{column_index}].format_parts[{part_index}].part_id",
        ) or str(uuid.uuid4())
        normalized_part: dict[str, Any] = {
            "part_id": part_id,
            "part_type": part_type,
        }

        if part_type == "text":
            value = str(raw_part.get("value", ""))
            if not value.strip():
                raise ValueError(f"columns[{column_index}].format_parts[{part_index}].value is required")
            normalized_part["value"] = value
        elif part_type == "space":
            normalized_part["value"] = " "
        else:
            template_id = _normalize_text(
                raw_part.get("template_id"),
                f"columns[{column_index}].format_parts[{part_index}].template_id",
                required=True,
            )
            field_key = _normalize_text(
                raw_part.get("field_key"),
                f"columns[{column_index}].format_parts[{part_index}].field_key",
                required=True,
            )
            assert template_id is not None
            assert field_key is not None
            normalized_part["template_id"] = template_id
            normalized_part["field_key"] = field_key

        normalized_parts.append(normalized_part)

    return normalized_parts


def parse_report_columns_payload(
    payload: list[dict[str, Any]] | None,
    *,
    required_template_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(payload, list) or not payload:
        raise ValueError("columns must include at least one item")

    normalized_columns: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(payload, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"columns[{index - 1}] must be an object")

        column_id = _normalize_text(item.get("column_id"), f"columns[{index - 1}].column_id") or str(uuid.uuid4())
        if column_id in seen_ids:
            raise ValueError(f"columns contains duplicate column_id '{column_id}'")
        seen_ids.add(column_id)

        label = _normalize_text(item.get("label"), f"columns[{index - 1}].label", required=True)
        assert label is not None
        source_type = _normalize_column_source_type(item.get("source_type"))
        value_type = _normalize_column_value_type(item.get("value_type"))
        try:
            order = int(item.get("order") or index)
        except (TypeError, ValueError):
            raise ValueError(f"columns[{index - 1}].order must be numeric")
        if order < 1:
            raise ValueError(f"columns[{index - 1}].order must be >= 1")

        normalized_item: dict[str, Any] = {
            "column_id": column_id,
            "label": label,
            "source_type": source_type,
            "value_type": value_type,
            "order": order,
        }

        if source_type == "system":
            system_key = _normalize_text(item.get("system_key"), f"columns[{index - 1}].system_key", required=True)
            assert system_key is not None
            if system_key not in VALID_SYSTEM_COLUMN_KEYS:
                raise ValueError(
                    "columns[%d].system_key must be one of: %s"
                    % (index - 1, ", ".join(sorted(VALID_SYSTEM_COLUMN_KEYS)))
                )
            normalized_item["system_key"] = system_key
            normalized_item["template_mappings"] = {}
            normalized_item["format_parts"] = []
        elif source_type == "template_field":
            raw_mappings = item.get("template_mappings")
            if not isinstance(raw_mappings, dict):
                raise ValueError(f"columns[{index - 1}].template_mappings must be an object")
            mappings: dict[str, str] = {}
            for raw_template_id, raw_field_key in raw_mappings.items():
                template_id = _normalize_text(raw_template_id, f"columns[{index - 1}].template_mappings.template_id")
                field_key = _normalize_text(
                    raw_field_key,
                    f"columns[{index - 1}].template_mappings[{raw_template_id}]",
                )
                if template_id and field_key:
                    mappings[template_id] = field_key
            if not mappings:
                raise ValueError(f"columns[{index - 1}].template_mappings must include at least one mapping")
            if required_template_ids:
                missing = sorted(required_template_ids - set(mappings))
                if missing:
                    raise ValueError(
                        "columns[%d] is missing template mappings for: %s"
                        % (index - 1, ", ".join(missing))
                    )
            normalized_item["template_mappings"] = mappings
            normalized_item["system_key"] = None
            normalized_item["format_parts"] = []
        else:
            normalized_item["format_parts"] = _parse_report_format_parts(item.get("format_parts"), index - 1)
            normalized_item["template_mappings"] = {}
            normalized_item["system_key"] = None

        normalized_columns.append(normalized_item)

    normalized_columns.sort(key=lambda item: (int(item["order"]), str(item["label"]).lower()))
    for order, item in enumerate(normalized_columns, start=1):
        item["order"] = order
    return normalized_columns


def init_report_layouts_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS report_layouts (
                  report_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  description TEXT NULL,
                  default_group_id TEXT NOT NULL,
                  default_output_format TEXT NOT NULL,
                  csv_delimiter TEXT NOT NULL DEFAULT ';',
                  columns_json JSONB NOT NULL,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_report_layouts_tenant_updated
                ON report_layouts ((LOWER(tenant_id)), updated_at DESC)
                """
            )
        conn.commit()


def init_report_runs_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS report_runs (
                  report_run_id TEXT PRIMARY KEY,
                  job_id TEXT NOT NULL UNIQUE,
                  report_id TEXT NULL,
                  tenant_id TEXT NOT NULL,
                  group_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  output_format TEXT NOT NULL,
                  csv_delimiter TEXT NOT NULL DEFAULT ';',
                  selected_files_json JSONB NOT NULL,
                  columns_snapshot_json JSONB NOT NULL,
                  artifact_path TEXT NULL,
                  artifact_filename TEXT NULL,
                  detail JSONB NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_report_runs_tenant_created
                ON report_runs ((LOWER(tenant_id)), created_at DESC)
                """
            )
        conn.commit()


def _row_to_report_layout(row: dict[str, Any]) -> ReportLayout:
    columns = row.get("columns_json")
    if not isinstance(columns, list):
        columns = []
    return ReportLayout(
        report_id=str(row["report_id"]),
        tenant_id=str(row["tenant_id"]),
        name=str(row["name"]),
        description=row.get("description"),
        default_group_id=str(row["default_group_id"]),
        default_output_format=str(row["default_output_format"]),
        csv_delimiter=str(row.get("csv_delimiter") or ";"),
        columns=columns,
        is_active=bool(row.get("is_active", True)),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_report_run(row: dict[str, Any]) -> ReportRun:
    selected_files = row.get("selected_files_json")
    if not isinstance(selected_files, list):
        selected_files = []
    columns_snapshot = row.get("columns_snapshot_json")
    if not isinstance(columns_snapshot, list):
        columns_snapshot = []
    detail = row.get("detail")
    if not isinstance(detail, dict):
        detail = None
    return ReportRun(
        report_run_id=str(row["report_run_id"]),
        job_id=str(row["job_id"]),
        report_id=row.get("report_id"),
        report_name=row.get("report_name"),
        tenant_id=str(row["tenant_id"]),
        group_id=str(row["group_id"]),
        status=str(row["status"]),
        output_format=str(row["output_format"]),
        csv_delimiter=str(row.get("csv_delimiter") or ";"),
        selected_files=selected_files,
        columns_snapshot=columns_snapshot,
        artifact_path=row.get("artifact_path"),
        artifact_filename=row.get("artifact_filename"),
        detail=detail,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_report_layouts(*, tenant_id: str, include_inactive: bool = True) -> list[ReportLayout]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    query = """
        SELECT report_id, tenant_id, name, description, default_group_id, default_output_format,
               csv_delimiter, columns_json, is_active, created_at, updated_at
        FROM report_layouts
        WHERE LOWER(tenant_id) = %s
    """
    params: list[Any] = [normalized_tenant]
    if not include_inactive:
        query += " AND is_active = TRUE"
    query += " ORDER BY updated_at DESC, name ASC"
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, tuple(params))
            rows = cur.fetchall()
    return [_row_to_report_layout(row) for row in rows]


def get_report_layout(*, tenant_id: str, report_id: str) -> ReportLayout | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_report_id = _normalize_text(report_id, "report_id", required=True)
    assert normalized_report_id is not None
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT report_id, tenant_id, name, description, default_group_id, default_output_format,
                       csv_delimiter, columns_json, is_active, created_at, updated_at
                FROM report_layouts
                WHERE LOWER(tenant_id) = %s AND report_id = %s
                """,
                (normalized_tenant, normalized_report_id),
            )
            row = cur.fetchone()
    return _row_to_report_layout(row) if row else None


def create_report_layout(
    *,
    tenant_id: str,
    name: str,
    description: str | None,
    default_group_id: str,
    default_output_format: str,
    csv_delimiter: str,
    columns: list[dict[str, Any]],
    is_active: bool = True,
) -> ReportLayout:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_group_id = _normalize_text(default_group_id, "default_group_id", required=True)
    normalized_description = _normalize_text(description, "description")
    assert normalized_name is not None
    assert normalized_group_id is not None

    normalized_columns = parse_report_columns_payload(columns)
    output_format = _normalize_output_format(default_output_format)
    delimiter = _normalize_csv_delimiter(csv_delimiter)
    report_id = str(uuid.uuid4())

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                INSERT INTO report_layouts (
                  report_id, tenant_id, name, description, default_group_id,
                  default_output_format, csv_delimiter, columns_json, is_active
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING report_id, tenant_id, name, description, default_group_id, default_output_format,
                          csv_delimiter, columns_json, is_active, created_at, updated_at
                """,
                (
                    report_id,
                    normalized_tenant,
                    normalized_name,
                    normalized_description,
                    normalized_group_id,
                    output_format,
                    delimiter,
                    Jsonb(normalized_columns),
                    bool(is_active),
                ),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise RuntimeError("Failed to create report layout")
    return _row_to_report_layout(row)


def update_report_layout(
    *,
    tenant_id: str,
    report_id: str,
    name: str,
    description: str | None,
    default_group_id: str,
    default_output_format: str,
    csv_delimiter: str,
    columns: list[dict[str, Any]],
    is_active: bool = True,
) -> ReportLayout | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_report_id = _normalize_text(report_id, "report_id", required=True)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_group_id = _normalize_text(default_group_id, "default_group_id", required=True)
    normalized_description = _normalize_text(description, "description")
    assert normalized_report_id is not None
    assert normalized_name is not None
    assert normalized_group_id is not None

    normalized_columns = parse_report_columns_payload(columns)
    output_format = _normalize_output_format(default_output_format)
    delimiter = _normalize_csv_delimiter(csv_delimiter)

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                UPDATE report_layouts
                SET
                  name = %s,
                  description = %s,
                  default_group_id = %s,
                  default_output_format = %s,
                  csv_delimiter = %s,
                  columns_json = %s,
                  is_active = %s,
                  updated_at = NOW()
                WHERE LOWER(tenant_id) = %s AND report_id = %s
                RETURNING report_id, tenant_id, name, description, default_group_id, default_output_format,
                          csv_delimiter, columns_json, is_active, created_at, updated_at
                """,
                (
                    normalized_name,
                    normalized_description,
                    normalized_group_id,
                    output_format,
                    delimiter,
                    Jsonb(normalized_columns),
                    bool(is_active),
                    normalized_tenant,
                    normalized_report_id,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_report_layout(row) if row else None


def delete_report_layout(*, tenant_id: str, report_id: str) -> bool:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_report_id = _normalize_text(report_id, "report_id", required=True)
    assert normalized_report_id is not None
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM report_layouts
                WHERE LOWER(tenant_id) = %s AND report_id = %s
                """,
                (normalized_tenant, normalized_report_id),
            )
            deleted = cur.rowcount > 0
        conn.commit()
    return deleted


def create_report_run(
    *,
    report_run_id: str,
    job_id: str,
    report_id: str | None,
    tenant_id: str,
    group_id: str,
    status: str,
    output_format: str,
    csv_delimiter: str,
    selected_files: list[dict[str, Any]],
    columns_snapshot: list[dict[str, Any]],
    detail: dict[str, Any] | None = None,
) -> ReportRun:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_group_id = _normalize_text(group_id, "group_id", required=True)
    normalized_report_run_id = _normalize_text(report_run_id, "report_run_id", required=True)
    normalized_job_id = _normalize_text(job_id, "job_id", required=True)
    assert normalized_group_id is not None
    assert normalized_report_run_id is not None
    assert normalized_job_id is not None

    normalized_status = _normalize_report_run_state(status)
    normalized_columns = parse_report_columns_payload(columns_snapshot)
    normalized_output = _normalize_output_format(output_format)
    normalized_delimiter = _normalize_csv_delimiter(csv_delimiter)

    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                INSERT INTO report_runs (
                  report_run_id, job_id, report_id, tenant_id, group_id, status, output_format,
                  csv_delimiter, selected_files_json, columns_snapshot_json, artifact_path,
                  artifact_filename, detail
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, NULL, %s)
                RETURNING report_run_id, job_id, report_id, tenant_id, group_id, status, output_format,
                          csv_delimiter, selected_files_json, columns_snapshot_json, artifact_path,
                          artifact_filename, detail, created_at, updated_at
                """,
                (
                    normalized_report_run_id,
                    normalized_job_id,
                    _normalize_text(report_id, "report_id"),
                    normalized_tenant,
                    normalized_group_id,
                    normalized_status,
                    normalized_output,
                    normalized_delimiter,
                    Jsonb(_jsonable(selected_files)),
                    Jsonb(_jsonable(normalized_columns)),
                    Jsonb(_jsonable(detail)) if detail is not None else None,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise RuntimeError("Failed to create report run")
    return _row_to_report_run(row)


def update_report_run_result(
    *,
    report_run_id: str,
    status: str,
    artifact_path: str | None = None,
    artifact_filename: str | None = None,
    detail: dict[str, Any] | None = None,
) -> ReportRun | None:
    normalized_report_run_id = _normalize_text(report_run_id, "report_run_id", required=True)
    assert normalized_report_run_id is not None
    normalized_status = _normalize_report_run_state(status)
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                UPDATE report_runs
                SET
                  status = %s,
                  artifact_path = %s,
                  artifact_filename = %s,
                  detail = %s,
                  updated_at = NOW()
                WHERE report_run_id = %s
                RETURNING report_run_id, job_id, report_id, tenant_id, group_id, status, output_format,
                          csv_delimiter, selected_files_json, columns_snapshot_json, artifact_path,
                          artifact_filename, detail, created_at, updated_at
                """,
                (
                    normalized_status,
                    _normalize_text(artifact_path, "artifact_path"),
                    _normalize_text(artifact_filename, "artifact_filename"),
                    Jsonb(_jsonable(detail)) if detail is not None else None,
                    normalized_report_run_id,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_report_run(row) if row else None


def get_report_run(*, tenant_id: str, report_run_id: str) -> ReportRun | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_report_run_id = _normalize_text(report_run_id, "report_run_id", required=True)
    assert normalized_report_run_id is not None
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT rr.report_run_id, rr.job_id, rr.report_id, rl.name AS report_name, rr.tenant_id, rr.group_id,
                       rr.status, rr.output_format, rr.csv_delimiter, rr.selected_files_json,
                       rr.columns_snapshot_json, rr.artifact_path, rr.artifact_filename, rr.detail,
                       rr.created_at, rr.updated_at
                FROM report_runs rr
                LEFT JOIN report_layouts rl
                  ON rl.report_id = rr.report_id
                 AND LOWER(rl.tenant_id) = LOWER(rr.tenant_id)
                WHERE LOWER(rr.tenant_id) = %s AND rr.report_run_id = %s
                """,
                (normalized_tenant, normalized_report_run_id),
            )
            row = cur.fetchone()
    return _row_to_report_run(row) if row else None


def list_report_runs(*, tenant_id: str, limit: int = 20) -> list[ReportRun]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    with get_postgres_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT rr.report_run_id, rr.job_id, rr.report_id, rl.name AS report_name, rr.tenant_id, rr.group_id,
                       rr.status, rr.output_format, rr.csv_delimiter, rr.selected_files_json,
                       rr.columns_snapshot_json, rr.artifact_path, rr.artifact_filename, rr.detail,
                       rr.created_at, rr.updated_at
                FROM report_runs rr
                LEFT JOIN report_layouts rl
                  ON rl.report_id = rr.report_id
                 AND LOWER(rl.tenant_id) = LOWER(rr.tenant_id)
                WHERE LOWER(rr.tenant_id) = %s
                ORDER BY
                  CASE WHEN rr.status = 'running' THEN 0 ELSE 1 END,
                  rr.created_at DESC
                LIMIT %s
                """,
                (normalized_tenant, max(1, min(int(limit), 50))),
            )
            rows = cur.fetchall()
    return [_row_to_report_run(row) for row in rows]


def _derive_report_run_state(job_status: str | None, detail: dict[str, Any] | None) -> str:
    normalized = _status_text(job_status)
    result = detail.get("result") if isinstance(detail, dict) else None
    progress = detail.get("progress") if isinstance(detail, dict) and isinstance(detail.get("progress"), dict) else None
    if normalized == "finished" and isinstance(result, dict):
        if str(result.get("status", "")).strip().lower() == "ok":
            return "success"
        return "error"
    if normalized == "finished":
        return "success"
    if normalized in {"queued", "started", "deferred", "scheduled", "created"}:
        return "running"
    if not normalized and isinstance(progress, dict):
        progress_status = str(progress.get("status", "")).strip().lower()
        if progress_status in {"running", "queued", "started", "scheduled", "created"}:
            return "running"
    return "error"


def sync_report_run(*, tenant_id: str, report_run_id: str) -> ReportRun | None:
    record = get_report_run(tenant_id=tenant_id, report_run_id=report_run_id)
    if not record or record.status != "running":
        return record
    try:
        job = Job.fetch(record.job_id, connection=get_redis())
    except Exception:
        return record

    detail = serialize_job_status(job)
    next_status = _derive_report_run_state(job.get_status(), detail)
    return update_report_run_result(
        report_run_id=record.report_run_id,
        status=next_status,
        artifact_path=record.artifact_path,
        artifact_filename=record.artifact_filename,
        detail=detail,
    ) or record


def list_recent_report_runs(*, tenant_id: str, limit: int = 20) -> list[ReportRun]:
    records = list_report_runs(tenant_id=tenant_id, limit=limit)
    synced: list[ReportRun] = []
    for record in records:
        synced.append(sync_report_run(tenant_id=tenant_id, report_run_id=record.report_run_id) or record)
    return synced


def serialize_report_layout(layout: ReportLayout) -> dict[str, Any]:
    return {
        "report_id": layout.report_id,
        "tenant_id": layout.tenant_id,
        "name": layout.name,
        "description": layout.description,
        "default_group_id": layout.default_group_id,
        "default_output_format": layout.default_output_format,
        "csv_delimiter": layout.csv_delimiter,
        "columns": _jsonable(layout.columns),
        "is_active": layout.is_active,
        "created_at": layout.created_at.isoformat() if layout.created_at else None,
        "updated_at": layout.updated_at.isoformat() if layout.updated_at else None,
    }


def serialize_report_run(record: ReportRun) -> dict[str, Any]:
    return {
        "report_run_id": record.report_run_id,
        "job_id": record.job_id,
        "report_id": record.report_id,
        "report_name": record.report_name,
        "tenant_id": record.tenant_id,
        "group_id": record.group_id,
        "status": record.status,
        "output_format": record.output_format,
        "csv_delimiter": record.csv_delimiter,
        "selected_files": _jsonable(record.selected_files),
        "columns_snapshot": _jsonable(record.columns_snapshot),
        "artifact_filename": record.artifact_filename,
        "artifact_available": bool(record.artifact_path and Path(record.artifact_path).exists()),
        "detail": _jsonable(record.detail) if record.detail is not None else None,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
    }


def _extract_template_field_catalog(template) -> list[dict[str, Any]]:
    def normalize_text(value: Any) -> str:
        if value is None:
            return ""
        return str(value).strip()

    payload = template.custom_model or {}
    fields = payload.get("fields") if isinstance(payload, dict) else None
    if not isinstance(fields, list):
        return []
    catalog: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in fields:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        name = normalize_text(item.get("name")) or key
        label = normalize_text(item.get("label")) or name or key
        catalog.append(
            {
                "key": key,
                "name": name,
                "label": label,
                "type": normalize_text(item.get("type") or "string").lower() or "string",
                "required": bool(item.get("required", False)),
            }
        )
    return catalog


def _get_group_document_templates(
    *,
    tenant_id: str,
    group_id: str,
    include_inactive: bool = True,
) -> list[Any]:
    templates = list_document_templates(tenant_id=tenant_id, include_inactive=include_inactive)
    return [
        template
        for template in templates
        if str(template.group_id or "").strip() == str(group_id or "").strip()
        and resolve_template_mode(template.custom_model) == "document"
    ]


def _build_drive_path_to_group(
    *,
    tenant_id: str,
    group_root_folder_id: str,
    file_meta: dict[str, Any],
) -> list[str] | None:
    cache: dict[str, dict[str, Any]] = {}

    def load_meta(file_id: str) -> dict[str, Any] | None:
        normalized = str(file_id or "").strip()
        if not normalized:
            return None
        if normalized not in cache:
            try:
                cache[normalized] = gdrive.get_file_metadata(
                    normalized,
                    tenant_id=tenant_id,
                    fields="id, name, parents",
                )
            except Exception:
                return None
        return cache.get(normalized)

    def walk(folder_id: str) -> list[str] | None:
        if folder_id == group_root_folder_id:
            return []
        meta = load_meta(folder_id)
        if not meta:
            return None
        folder_name = str(meta.get("name", "")).strip()
        parents = meta.get("parents") or []
        for parent_id in parents:
            chain = walk(str(parent_id))
            if chain is not None:
                return [*chain, folder_name]
        return None

    parents = file_meta.get("parents") or []
    for parent_id in parents:
        chain = walk(str(parent_id))
        if chain is not None:
            return chain
    return None


def resolve_report_selection(
    *,
    tenant_id: str,
    group_id: str,
    file_ids: list[str],
) -> dict[str, Any]:
    group = get_template_group(tenant_id=tenant_id, group_id=group_id)
    if group is None:
        raise ValueError("Template group not found")

    group_templates = _get_group_document_templates(
        tenant_id=tenant_id,
        group_id=group.group_id,
        include_inactive=True,
    )
    active_group_templates = [template for template in group_templates if bool(getattr(template, "is_active", False))]
    templates_by_id = {template.template_id: template for template in group_templates}
    active_templates_by_id = {template.template_id: template for template in active_group_templates}
    normalized_file_ids: list[str] = []
    seen_ids: set[str] = set()
    for raw_file_id in file_ids:
        file_id = str(raw_file_id or "").strip()
        if file_id and file_id not in seen_ids:
            seen_ids.add(file_id)
            normalized_file_ids.append(file_id)
    if not normalized_file_ids:
        raise ValueError("file_ids must include at least one file")

    files: list[dict[str, Any]] = []
    resolved_template_ids: set[str] = set()

    for file_id in normalized_file_ids:
        try:
            file_meta = gdrive.get_file_metadata(
                file_id,
                tenant_id=tenant_id,
                fields="id, name, mimeType, parents, appProperties, createdTime, modifiedTime, webViewLink",
            )
        except Exception as exc:
            files.append(
                {
                    "file_id": file_id,
                    "name": file_id,
                    "relative_path": None,
                    "template_binding_status": "invalid",
                    "template_id": None,
                    "template_name": None,
                    "processed_at": None,
                    "error": str(exc),
                }
            )
            continue

        relative_folder_chain = _build_drive_path_to_group(
            tenant_id=tenant_id,
            group_root_folder_id=group.drive_folder_id,
            file_meta=file_meta,
        )
        if relative_folder_chain is None:
            files.append(
                {
                    "file_id": str(file_meta.get("id", file_id)),
                    "name": str(file_meta.get("name", file_id)),
                    "relative_path": None,
                    "template_binding_status": "outside_group",
                    "template_id": None,
                    "template_name": None,
                    "processed_at": None,
                    "error": "File does not belong to selected group",
                }
            )
            continue

        mime_type = str(file_meta.get("mimeType", "")).strip().lower()
        if mime_type != "application/pdf":
            files.append(
                {
                    "file_id": str(file_meta.get("id", file_id)),
                    "name": str(file_meta.get("name", file_id)).strip() or file_id,
                    "relative_path": "/".join([*relative_folder_chain, str(file_meta.get("name", file_id)).strip()]),
                    "template_binding_status": "invalid",
                    "template_id": None,
                    "template_name": None,
                    "processed_at": None,
                    "created_at": file_meta.get("createdTime"),
                    "modified_at": file_meta.get("modifiedTime"),
                    "web_view_link": file_meta.get("webViewLink"),
                    "error": "Only PDF files can be used in reports",
                }
            )
            continue

        relative_path = "/".join([*relative_folder_chain, str(file_meta.get("name", file_id)).strip()])
        app_properties = file_meta.get("appProperties") or {}
        template_id = str(app_properties.get("recibox_template_id", "")).strip() or None
        stored_group_id = str(app_properties.get("recibox_group_id", "")).strip() or None
        processed_at = str(app_properties.get("recibox_processed_at", "")).strip() or None

        binding_status = "legacy"
        template_name = None
        error = None
        if template_id:
            if stored_group_id and stored_group_id != group.group_id:
                binding_status = "mismatch"
                error = "File metadata points to a different group"
            else:
                template = templates_by_id.get(template_id)
                if template is None:
                    existing_template = get_document_template(tenant_id=tenant_id, template_id=template_id)
                    if existing_template is None:
                        binding_status = "mismatch"
                        error = "Bound template does not exist"
                    elif resolve_template_mode(existing_template.custom_model) != "document":
                        binding_status = "mismatch"
                        error = "Bound template is not compatible with reports"
                    elif str(existing_template.group_id or "").strip() != group.group_id:
                        binding_status = "mismatch"
                        error = "Bound template belongs to a different group"
                    elif not bool(existing_template.is_active):
                        binding_status = "mismatch"
                        error = "Bound template is inactive"
                    else:
                        binding_status = "ready"
                        template_name = existing_template.name
                        resolved_template_ids.add(existing_template.template_id)
                elif not bool(template.is_active):
                    binding_status = "mismatch"
                    error = "Bound template is inactive"
                else:
                    binding_status = "ready"
                    template_name = template.name
                    resolved_template_ids.add(template.template_id)

        files.append(
            {
                "file_id": str(file_meta.get("id", file_id)),
                "name": str(file_meta.get("name", file_id)).strip() or file_id,
                "relative_path": relative_path,
                "template_binding_status": binding_status,
                "template_id": template_id,
                "template_name": template_name,
                "processed_at": processed_at,
                "created_at": file_meta.get("createdTime"),
                "modified_at": file_meta.get("modifiedTime"),
                "web_view_link": file_meta.get("webViewLink"),
                "error": error,
            }
        )

    present_templates = [
        active_templates_by_id[template_id]
        for template_id in sorted(resolved_template_ids)
        if template_id in active_templates_by_id
    ]
    binding_templates = sorted(active_group_templates, key=lambda item: item.name.lower())

    return {
        "group": {
            "group_id": group.group_id,
            "name": group.name,
            "drive_folder_id": group.drive_folder_id,
        },
        "files": files,
        "templates": [
            {
                "template_id": template.template_id,
                "name": template.name,
                "group_id": template.group_id,
                "is_active": template.is_active,
                "fields": _extract_template_field_catalog(template),
            }
            for template in present_templates
        ],
        "binding_templates": [
            {
                "template_id": template.template_id,
                "name": template.name,
                "group_id": template.group_id,
                "is_active": template.is_active,
                "fields": _extract_template_field_catalog(template),
            }
            for template in binding_templates
        ],
        "system_fields": [
            {"key": "file_name", "label": "Nombre de archivo", "value_type": "string"},
            {"key": "relative_path", "label": "Ruta relativa", "value_type": "string"},
            {"key": "template_name", "label": "Plantilla", "value_type": "string"},
            {"key": "processed_at", "label": "Procesado el", "value_type": "date"},
        ],
    }


def bind_report_file_template(
    *,
    tenant_id: str,
    group_id: str,
    file_id: str,
    template_id: str,
) -> dict[str, Any]:
    group = get_template_group(tenant_id=tenant_id, group_id=group_id)
    if group is None:
        raise ValueError("Template group not found")

    template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    if template is None:
        raise ValueError("Template not found")
    if str(template.group_id or "").strip() != group.group_id:
        raise ValueError("Template does not belong to selected group")
    if resolve_template_mode(template.custom_model) != "document":
        raise ValueError("Template is not compatible with reports")
    if not bool(template.is_active):
        raise ValueError("Template is inactive")

    selection = resolve_report_selection(tenant_id=tenant_id, group_id=group_id, file_ids=[file_id])
    resolved_file = selection["files"][0]
    if resolved_file["template_binding_status"] == "outside_group":
        raise ValueError("File does not belong to selected group")
    if resolved_file["template_binding_status"] == "invalid":
        raise ValueError(str(resolved_file.get("error") or "File cannot be used in reports"))

    classification_rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
    processed_at = str(resolved_file.get("processed_at") or "").strip() or datetime.now(timezone.utc).isoformat()

    updated = gdrive.update_file_metadata(
        file_id,
        tenant_id=tenant_id,
        app_properties={
            "recibox_template_id": template.template_id,
            "recibox_group_id": group.group_id,
            "recibox_rule_id": str(classification_rule.rule_id) if classification_rule is not None else "",
            "recibox_processed_at": processed_at,
            "recibox_processor_version": str(settings.report_processor_version or "v1"),
        },
    )
    return {
        "file_id": str(updated.get("id", file_id)),
        "template_id": template.template_id,
        "template_name": template.name,
        "group_id": group.group_id,
        "app_properties": updated.get("appProperties") or {},
    }


def _ensure_ready_selection(selection: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    files = selection.get("files") or []
    ready_files = [item for item in files if item.get("template_binding_status") == "ready"]
    if len(ready_files) != len(files):
        invalid = [item.get("name") or item.get("file_id") for item in files if item.get("template_binding_status") != "ready"]
        raise ValueError("Selection contains files without valid template binding: %s" % ", ".join(map(str, invalid)))
    template_ids = {str(item.get("template_id", "")).strip() for item in ready_files if str(item.get("template_id", "")).strip()}
    return ready_files, template_ids


def _artifact_base_dir(*, tenant_id: str) -> Path:
    tenant_dir = Path(settings.report_artifacts_dir) / _normalize_tenant_id(tenant_id)
    tenant_dir.mkdir(parents=True, exist_ok=True)
    return tenant_dir


def _write_csv_artifact(
    *,
    artifact_path: Path,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    delimiter: str,
) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    with artifact_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter=delimiter)
        writer.writerow([str(column["label"]) for column in columns])
        for row in rows:
            writer.writerow([str(row.get(str(column["column_id"]), "") or "") for column in columns])


def _write_xlsx_artifact(
    *,
    artifact_path: Path,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise RuntimeError("openpyxl is required to generate XLSX reports") from exc

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Reporte"
    worksheet.append([str(column["label"]) for column in columns])
    for row in rows:
        worksheet.append([row.get(str(column["column_id"]), "") for column in columns])
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(str(artifact_path))


def _sanitize_report_filename_stem(value: str | None) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    sanitized = re.sub(r'[\\/:*?"<>|]+', " ", normalized)
    sanitized = re.sub(r"\s+", " ", sanitized).strip(" .")
    sanitized = re.sub(r"\.(csv|xlsx)$", "", sanitized, flags=re.IGNORECASE).strip(" .")
    return sanitized[:120].strip()


def _build_run_artifact_paths(
    *,
    tenant_id: str,
    report_run_id: str,
    output_format: str,
    report_name: str | None = None,
    generated_at: datetime | None = None,
) -> tuple[Path, str]:
    artifact_base = _artifact_base_dir(tenant_id=tenant_id)
    extension = "csv" if output_format == "csv" else "xlsx"
    stem = _sanitize_report_filename_stem(report_name)
    if not stem:
        timestamp = (generated_at or datetime.now(timezone.utc)).strftime("%Y%m%d_%H%M%S")
        stem = f"Reporte_{timestamp}"
    filename = f"{stem}.{extension}"
    return artifact_base / report_run_id / filename, filename


def _collect_requested_fields_by_template(
    *,
    columns: list[dict[str, Any]],
    template_ids: set[str],
) -> dict[str, set[str]]:
    requested_fields_by_template: dict[str, set[str]] = {template_id: set() for template_id in template_ids}
    for column in columns:
        source_type = str(column.get("source_type") or "").strip()
        if source_type == "template_field":
            mappings = column.get("template_mappings") or {}
            for template_id, field_key in mappings.items():
                if template_id in requested_fields_by_template:
                    requested_fields_by_template[template_id].add(str(field_key))
            continue

        if source_type != "composite":
            continue

        for part in column.get("format_parts") or []:
            if not isinstance(part, dict) or part.get("part_type") != "field":
                continue
            template_id = str(part.get("template_id") or "").strip()
            field_key = str(part.get("field_key") or "").strip()
            if template_id in requested_fields_by_template and field_key:
                requested_fields_by_template[template_id].add(field_key)
    return requested_fields_by_template


def _render_system_report_column(*, system_key: str, file_item: dict[str, Any]) -> str:
    if system_key == "file_name":
        return str(file_item.get("name", "")).strip()
    if system_key == "relative_path":
        return str(file_item.get("relative_path", "") or "")
    if system_key == "template_name":
        return str(file_item.get("template_name", "") or "")
    if system_key == "processed_at":
        return str(file_item.get("processed_at", "") or "")
    return ""


def _render_composite_report_column(
    *,
    column: dict[str, Any],
    template_id: str,
    value_map: dict[str, Any],
) -> str:
    rendered_parts: list[str] = []
    for part in column.get("format_parts") or []:
        if not isinstance(part, dict):
            continue
        part_type = str(part.get("part_type") or "").strip()
        if part_type == "text":
            rendered_parts.append(str(part.get("value", "")))
        elif part_type == "space":
            rendered_parts.append(" ")
        elif part_type == "field" and str(part.get("template_id") or "").strip() == template_id:
            field_key = str(part.get("field_key") or "").strip()
            rendered_parts.append(str(value_map.get(field_key, "") or ""))
    return "".join(rendered_parts)


def run_report_flow(
    *,
    report_run_id: str,
    tenant_id: str,
    group_id: str,
    file_ids: list[str],
    output_format: str,
    csv_delimiter: str,
    columns: list[dict[str, Any]],
    report_name: str | None = None,
) -> dict[str, Any]:
    normalized_output = _normalize_output_format(output_format)
    normalized_delimiter = _normalize_csv_delimiter(csv_delimiter)
    try:
        selection = resolve_report_selection(tenant_id=tenant_id, group_id=group_id, file_ids=file_ids)
        ready_files, template_ids = _ensure_ready_selection(selection)
        normalized_columns = parse_report_columns_payload(columns, required_template_ids=template_ids)
        _update_current_job_progress(
            processed=0,
            total=len(ready_files),
            ok=0,
            error=0,
            status="running",
            message="Preparando reporte",
        )
        templates_by_id = {
            template_id: get_document_template(tenant_id=tenant_id, template_id=template_id)
            for template_id in template_ids
        }
        requested_fields_by_template = _collect_requested_fields_by_template(
            columns=normalized_columns,
            template_ids=template_ids,
        )

        rows: list[dict[str, Any]] = []
        local_dir = Path(settings.local_download_dir)
        local_dir.mkdir(parents=True, exist_ok=True)
        ok_count = 0

        for index, file_item in enumerate(ready_files, start=1):
            file_id = str(file_item["file_id"])
            template_id = str(file_item["template_id"])
            template = templates_by_id.get(template_id)
            if template is None:
                raise RuntimeError(f"Template '{template_id}' not found for file '{file_id}'")

            local_path = local_dir / f"report-{report_run_id}-{file_id}.pdf"
            try:
                gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
                value_map = extract_template_value_map_from_local_pdf(
                    local_path,
                    template=template,
                    requested_field_keys=requested_fields_by_template.get(template_id) or None,
                )
            finally:
                try:
                    local_path.unlink(missing_ok=True)
                except Exception:
                    pass

            row: dict[str, Any] = {}
            for column in normalized_columns:
                column_id = str(column["column_id"])
                if column["source_type"] == "system":
                    row[column_id] = _render_system_report_column(
                        system_key=str(column.get("system_key") or ""),
                        file_item=file_item,
                    )
                elif column["source_type"] == "template_field":
                    field_key = str((column.get("template_mappings") or {}).get(template_id, "")).strip()
                    row[column_id] = str(value_map.get(field_key, "") or "")
                else:
                    row[column_id] = _render_composite_report_column(
                        column=column,
                        template_id=template_id,
                        value_map=value_map,
                    )
            rows.append(row)
            ok_count += 1
            _update_current_job_progress(
                processed=index,
                total=len(ready_files),
                ok=ok_count,
                error=0,
                status="running",
                message=f"Procesando {file_item.get('name', file_id)}",
            )

        artifact_path, artifact_filename = _build_run_artifact_paths(
            tenant_id=tenant_id,
            report_run_id=report_run_id,
            output_format=normalized_output,
            report_name=report_name,
        )
        if normalized_output == "csv":
            _write_csv_artifact(
                artifact_path=artifact_path,
                columns=normalized_columns,
                rows=rows,
                delimiter=normalized_delimiter,
            )
        else:
            _write_xlsx_artifact(
                artifact_path=artifact_path,
                columns=normalized_columns,
                rows=rows,
            )

        detail = {
            "status": "ok",
            "rows": len(rows),
            "files_count": len(ready_files),
            "columns_count": len(normalized_columns),
            "artifact_filename": artifact_filename,
        }
        _update_current_job_progress(
            processed=len(ready_files),
            total=len(ready_files),
            ok=ok_count,
            error=0,
            status="ok",
            message="Reporte generado",
        )
        update_report_run_result(
            report_run_id=report_run_id,
            status="success",
            artifact_path=str(artifact_path),
            artifact_filename=artifact_filename,
            detail=detail,
        )
        return detail
    except Exception as exc:
        detail = {
            "status": "error",
            "message": str(exc),
        }
        _update_current_job_progress(
            processed=0,
            total=0,
            ok=0,
            error=1,
            status="error",
            message=str(exc),
        )
        update_report_run_result(
            report_run_id=report_run_id,
            status="error",
            detail=detail,
        )
        return detail
