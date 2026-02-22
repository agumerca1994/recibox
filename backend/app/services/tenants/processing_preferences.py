from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from redis import Redis

DEFAULT_FILENAME_FORMAT_MODE = "mm_yyyy_employee"
DEFAULT_EMPLOYEE_FOLDER_NUMBER_MODE = "indexed_number"

VALID_FILENAME_FORMAT_MODES = {
    "mm_yyyy_employee",
    "yyyy_mm_employee",
    "yyyy_employee",
    "custom",
}

VALID_EMPLOYEE_FOLDER_NUMBER_MODES = {
    "indexed_number",
    "number_only",
    "no_index",
    "custom",
}

VALID_FILENAME_PART_TOKENS = {"MM", "YYYY", "EMPLOYEE", "NONE"}
VALID_FILENAME_SEPARATORS = {"-", "/", "", ")"}


@dataclass
class FilenameCustomFormat:
    part1: str = "MM"
    sep1: str = "-"
    part2: str = "YYYY"
    sep2: str = ")"
    part3: str = "EMPLOYEE"


@dataclass
class TenantProcessingPreferences:
    tenant_id: str
    filename_format_mode: str
    filename_custom_format: FilenameCustomFormat
    employee_folder_number_mode: str
    employee_folder_number_custom_part1: str
    employee_folder_number_custom_part2: str
    auto_create_missing_employee_folder: bool
    source: str
    updated_at: str | None = None


def _key(tenant_id: str) -> str:
    return f"recibox:tenant:{tenant_id}:processing_preferences"


def _normalize_token(value: str, field: str) -> str:
    token = str(value or "").strip().upper()
    if token not in VALID_FILENAME_PART_TOKENS:
        raise ValueError(f"{field} must be one of: {', '.join(sorted(VALID_FILENAME_PART_TOKENS))}")
    return token


def _normalize_separator(value: str, field: str) -> str:
    sep = str(value or "")
    if sep not in VALID_FILENAME_SEPARATORS:
        raise ValueError(f"{field} must be one of: '-', '/', ')', or empty")
    return sep


def _normalize_custom_format(payload: dict | None) -> FilenameCustomFormat:
    raw = payload or {}
    normalized = FilenameCustomFormat(
        part1=_normalize_token(raw.get("part1", "MM"), "filename_custom_format.part1"),
        sep1=_normalize_separator(raw.get("sep1", "-"), "filename_custom_format.sep1"),
        part2=_normalize_token(raw.get("part2", "YYYY"), "filename_custom_format.part2"),
        sep2=_normalize_separator(raw.get("sep2", ")"), "filename_custom_format.sep2"),
        part3=_normalize_token(raw.get("part3", "EMPLOYEE"), "filename_custom_format.part3"),
    )
    if normalized.part1 == "NONE" and normalized.part2 == "NONE" and normalized.part3 == "NONE":
        raise ValueError("filename_custom_format must include at least one non-empty part")
    return normalized


def _normalize_employee_folder_custom_parts(part1: str | None, part2: str | None) -> tuple[str, str]:
    p1 = str(part1 or "").strip()
    p2 = str(part2 or "").strip()
    return p1, p2


def load_tenant_processing_preferences(redis_conn: Redis, tenant_id: str) -> TenantProcessingPreferences | None:
    raw = redis_conn.get(_key(tenant_id))
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"Invalid processing preferences for '{tenant_id}': {exc}") from exc

    mode = str(payload.get("filename_format_mode", "")).strip()
    if mode not in VALID_FILENAME_FORMAT_MODES:
        return None

    custom = _normalize_custom_format(payload.get("filename_custom_format"))
    employee_mode = str(payload.get("employee_folder_number_mode", DEFAULT_EMPLOYEE_FOLDER_NUMBER_MODE)).strip()
    if employee_mode not in VALID_EMPLOYEE_FOLDER_NUMBER_MODES:
        employee_mode = DEFAULT_EMPLOYEE_FOLDER_NUMBER_MODE
    part1, part2 = _normalize_employee_folder_custom_parts(
        payload.get("employee_folder_number_custom_part1"),
        payload.get("employee_folder_number_custom_part2"),
    )
    if employee_mode == "custom" and not (part1 or part2):
        raise ValueError("employee_folder_number custom mode requires at least one custom part")
    return TenantProcessingPreferences(
        tenant_id=tenant_id,
        filename_format_mode=mode,
        filename_custom_format=custom,
        employee_folder_number_mode=employee_mode,
        employee_folder_number_custom_part1=part1,
        employee_folder_number_custom_part2=part2,
        auto_create_missing_employee_folder=bool(payload.get("auto_create_missing_employee_folder", True)),
        source="tenant",
        updated_at=payload.get("updated_at"),
    )


def default_processing_preferences(tenant_id: str) -> TenantProcessingPreferences:
    return TenantProcessingPreferences(
        tenant_id=tenant_id,
        filename_format_mode=DEFAULT_FILENAME_FORMAT_MODE,
        filename_custom_format=FilenameCustomFormat(),
        employee_folder_number_mode=DEFAULT_EMPLOYEE_FOLDER_NUMBER_MODE,
        employee_folder_number_custom_part1="",
        employee_folder_number_custom_part2="",
        auto_create_missing_employee_folder=True,
        source="default",
        updated_at=None,
    )


def save_tenant_processing_preferences(
    redis_conn: Redis,
    tenant_id: str,
    *,
    filename_format_mode: str,
    filename_custom_format: dict | None = None,
    employee_folder_number_mode: str = DEFAULT_EMPLOYEE_FOLDER_NUMBER_MODE,
    employee_folder_number_custom_part1: str | None = None,
    employee_folder_number_custom_part2: str | None = None,
    auto_create_missing_employee_folder: bool = True,
) -> TenantProcessingPreferences:
    mode = str(filename_format_mode or "").strip()
    if mode not in VALID_FILENAME_FORMAT_MODES:
        raise ValueError(f"filename_format_mode must be one of: {', '.join(sorted(VALID_FILENAME_FORMAT_MODES))}")

    custom = _normalize_custom_format(filename_custom_format)
    employee_mode = str(employee_folder_number_mode or "").strip()
    if employee_mode not in VALID_EMPLOYEE_FOLDER_NUMBER_MODES:
        raise ValueError(
            f"employee_folder_number_mode must be one of: {', '.join(sorted(VALID_EMPLOYEE_FOLDER_NUMBER_MODES))}"
        )
    part1, part2 = _normalize_employee_folder_custom_parts(
        employee_folder_number_custom_part1,
        employee_folder_number_custom_part2,
    )
    if employee_mode == "custom" and not (part1 or part2):
        raise ValueError("employee_folder_number custom mode requires at least one custom part")
    cfg = TenantProcessingPreferences(
        tenant_id=tenant_id,
        filename_format_mode=mode,
        filename_custom_format=custom,
        employee_folder_number_mode=employee_mode,
        employee_folder_number_custom_part1=part1,
        employee_folder_number_custom_part2=part2,
        auto_create_missing_employee_folder=bool(auto_create_missing_employee_folder),
        source="tenant",
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    redis_conn.set(_key(tenant_id), json.dumps(asdict(cfg)))
    return cfg


def clear_tenant_processing_preferences(redis_conn: Redis, tenant_id: str) -> bool:
    return bool(redis_conn.delete(_key(tenant_id)))


def resolve_tenant_processing_preferences(redis_conn: Redis, tenant_id: str) -> TenantProcessingPreferences:
    cfg = load_tenant_processing_preferences(redis_conn, tenant_id)
    if cfg:
        return cfg
    return default_processing_preferences(tenant_id)
