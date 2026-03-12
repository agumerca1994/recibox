from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime

VALID_TRANSFORM_OPERATIONS = {"trim", "replace", "remove_chars", "split", "case", "date_format"}
VALID_CASE_MODES = {"upper", "lower", "title"}
VALID_DATE_OUTPUT_FORMATS = {"DD", "MM", "YYYY", "MM/YYYY", "YYYY-MM", "MMM", "MMMM"}
SPANISH_MONTHS = {
    "enero": 1,
    "ene": 1,
    "febrero": 2,
    "feb": 2,
    "marzo": 3,
    "mar": 3,
    "abril": 4,
    "abr": 4,
    "mayo": 5,
    "may": 5,
    "junio": 6,
    "jun": 6,
    "julio": 7,
    "jul": 7,
    "agosto": 8,
    "ago": 8,
    "septiembre": 9,
    "setiembre": 9,
    "sep": 9,
    "set": 9,
    "octubre": 10,
    "oct": 10,
    "noviembre": 11,
    "nov": 11,
    "diciembre": 12,
    "dic": 12,
}
MONTH_ABBR = {
    1: "ENE",
    2: "FEB",
    3: "MAR",
    4: "ABR",
    5: "MAY",
    6: "JUN",
    7: "JUL",
    8: "AGO",
    9: "SEP",
    10: "OCT",
    11: "NOV",
    12: "DIC",
}
MONTH_FULL = {
    1: "ENERO",
    2: "FEBRERO",
    3: "MARZO",
    4: "ABRIL",
    5: "MAYO",
    6: "JUNIO",
    7: "JULIO",
    8: "AGOSTO",
    9: "SEPTIEMBRE",
    10: "OCTUBRE",
    11: "NOVIEMBRE",
    12: "DICIEMBRE",
}


def _get_postgres_conn():
    from app.db.postgres import get_postgres_conn

    return get_postgres_conn()


@dataclass
class FieldTransformStep:
    transform_id: str
    template_id: str
    field_key: str
    step_order: int
    operation: str
    param_from: str | None
    param_to: str | None
    param_chars: str | None
    param_delimiter: str | None
    param_index: int | None
    param_case: str | None
    param_date_output: str | None
    created_at: datetime


@dataclass
class FieldTransformStepInput:
    operation: str
    param_from: str | None = None
    param_to: str | None = None
    param_chars: str | None = None
    param_delimiter: str | None = None
    param_index: int | None = None
    param_case: str | None = None
    param_date_output: str | None = None


@dataclass
class FieldTransformGroupInput:
    field_key: str
    steps: list[FieldTransformStepInput]


def init_template_field_transforms_schema() -> None:
    with _get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS template_field_transforms (
                  transform_id TEXT PRIMARY KEY,
                  template_id TEXT NOT NULL,
                  field_key TEXT NOT NULL,
                  step_order INTEGER NOT NULL,
                  operation TEXT NOT NULL,
                  param_from TEXT NULL,
                  param_to TEXT NULL,
                  param_chars TEXT NULL,
                  param_delimiter TEXT NULL,
                  param_index INTEGER NULL,
                  param_case TEXT NULL,
                  param_date_output TEXT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  CONSTRAINT fk_template_field_transforms_template
                    FOREIGN KEY (template_id)
                    REFERENCES document_templates(template_id)
                    ON DELETE CASCADE,
                  CONSTRAINT chk_template_field_transforms_order
                    CHECK (step_order BETWEEN 1 AND 3),
                  CONSTRAINT chk_template_field_transforms_operation
                    CHECK (operation IN ('trim', 'replace', 'remove_chars', 'split', 'case', 'date_format')),
                  CONSTRAINT chk_template_field_transforms_case
                    CHECK (param_case IS NULL OR param_case IN ('upper', 'lower', 'title')),
                  CONSTRAINT chk_template_field_transforms_date
                    CHECK (param_date_output IS NULL OR param_date_output IN ('DD', 'MM', 'YYYY', 'MM/YYYY', 'YYYY-MM', 'MMM', 'MMMM')),
                  CONSTRAINT chk_template_field_transforms_split
                    CHECK (param_index IS NULL OR param_index >= 1)
                )
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_template_field_transforms_unique_order
                ON template_field_transforms (template_id, field_key, step_order)
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_template_field_transforms_template
                ON template_field_transforms (template_id, field_key)
                """
            )
        conn.commit()


def _normalize_text(value: object, field: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if required and not normalized:
        raise ValueError(f"{field} is required")
    return normalized or None


def _parse_step(operation: str, raw_step: dict, field_name: str) -> FieldTransformStepInput:
    op = operation
    if op == "trim":
        return FieldTransformStepInput(operation=op)

    if op == "replace":
        from_value = _normalize_text(raw_step.get("from"), f"{field_name}.from", required=True)
        assert from_value is not None
        to_value = str(raw_step.get("to", ""))
        return FieldTransformStepInput(operation=op, param_from=from_value, param_to=to_value)

    if op == "remove_chars":
        chars = _normalize_text(raw_step.get("chars"), f"{field_name}.chars", required=True)
        assert chars is not None
        return FieldTransformStepInput(operation=op, param_chars=chars)

    if op == "split":
        delimiter = _normalize_text(raw_step.get("delimiter"), f"{field_name}.delimiter", required=True)
        assert delimiter is not None
        index_value = raw_step.get("index")
        try:
            index = int(index_value)
        except (TypeError, ValueError):
            raise ValueError(f"{field_name}.index must be an integer")
        if index < 1:
            raise ValueError(f"{field_name}.index must be >= 1")
        return FieldTransformStepInput(operation=op, param_delimiter=delimiter, param_index=index)

    if op == "case":
        case_mode = _normalize_text(raw_step.get("mode"), f"{field_name}.mode", required=True)
        assert case_mode is not None
        case_mode = case_mode.lower()
        if case_mode not in VALID_CASE_MODES:
            raise ValueError(f"{field_name}.mode must be one of: {', '.join(sorted(VALID_CASE_MODES))}")
        return FieldTransformStepInput(operation=op, param_case=case_mode)

    if op == "date_format":
        output = _normalize_text(raw_step.get("output"), f"{field_name}.output", required=True)
        assert output is not None
        output = output.upper()
        if output not in VALID_DATE_OUTPUT_FORMATS:
            raise ValueError(
                f"{field_name}.output must be one of: {', '.join(sorted(VALID_DATE_OUTPUT_FORMATS))}"
            )
        return FieldTransformStepInput(operation=op, param_date_output=output)

    raise ValueError(f"{field_name}.operation is not supported")


def parse_field_transforms_payload(payload: list[dict] | None, *, available_field_keys: set[str]) -> list[FieldTransformGroupInput]:
    if payload is None:
        return []
    if not isinstance(payload, list):
        raise ValueError("field_transforms must be a list")

    groups: list[FieldTransformGroupInput] = []
    seen_field_keys: set[str] = set()
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"field_transforms[{index}] must be an object")

        field_key = _normalize_text(item.get("field_key"), f"field_transforms[{index}].field_key", required=True)
        assert field_key is not None
        if field_key in seen_field_keys:
            raise ValueError(f"field_transforms contains duplicate field_key '{field_key}'")
        seen_field_keys.add(field_key)

        if field_key not in available_field_keys:
            raise ValueError(f"field_transforms[{index}].field_key '{field_key}' is not present in template")

        raw_steps = item.get("steps")
        if not isinstance(raw_steps, list):
            raise ValueError(f"field_transforms[{index}].steps must be a list")
        if len(raw_steps) > 3:
            raise ValueError(f"field_transforms[{index}].steps supports up to 3 steps")

        steps: list[FieldTransformStepInput] = []
        for step_index, raw_step in enumerate(raw_steps):
            if not isinstance(raw_step, dict):
                raise ValueError(f"field_transforms[{index}].steps[{step_index}] must be an object")
            operation = _normalize_text(
                raw_step.get("operation"),
                f"field_transforms[{index}].steps[{step_index}].operation",
                required=True,
            )
            assert operation is not None
            operation = operation.lower()
            if operation not in VALID_TRANSFORM_OPERATIONS:
                raise ValueError(
                    f"field_transforms[{index}].steps[{step_index}].operation must be one of: "
                    + ", ".join(sorted(VALID_TRANSFORM_OPERATIONS))
                )
            step = _parse_step(operation, raw_step, f"field_transforms[{index}].steps[{step_index}]")
            steps.append(step)

        groups.append(FieldTransformGroupInput(field_key=field_key, steps=steps))

    return groups


def _row_to_step(row: tuple) -> FieldTransformStep:
    return FieldTransformStep(
        transform_id=row[0],
        template_id=row[1],
        field_key=row[2],
        step_order=row[3],
        operation=row[4],
        param_from=row[5],
        param_to=row[6],
        param_chars=row[7],
        param_delimiter=row[8],
        param_index=row[9],
        param_case=row[10],
        param_date_output=row[11],
        created_at=row[12],
    )


def list_template_field_transforms(*, template_id: str) -> list[FieldTransformStep]:
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    assert normalized_template_id is not None

    with _get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT transform_id, template_id, field_key, step_order, operation,
                       param_from, param_to, param_chars, param_delimiter, param_index,
                       param_case, param_date_output, created_at
                FROM template_field_transforms
                WHERE template_id = %s
                ORDER BY field_key ASC, step_order ASC
                """,
                (normalized_template_id,),
            )
            rows = cur.fetchall()
    return [_row_to_step(row) for row in rows]


def list_template_field_transforms_map(*, template_ids: list[str]) -> dict[str, list[FieldTransformStep]]:
    normalized_template_ids = [
        item for item in (_normalize_text(template_id, "template_id") for template_id in template_ids) if item
    ]
    if not normalized_template_ids:
        return {}

    with _get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT transform_id, template_id, field_key, step_order, operation,
                       param_from, param_to, param_chars, param_delimiter, param_index,
                       param_case, param_date_output, created_at
                FROM template_field_transforms
                WHERE template_id = ANY(%s::text[])
                ORDER BY template_id ASC, field_key ASC, step_order ASC
                """,
                (normalized_template_ids,),
            )
            rows = cur.fetchall()

    out: dict[str, list[FieldTransformStep]] = {}
    for row in rows:
        step = _row_to_step(row)
        out.setdefault(step.template_id, []).append(step)
    return out


def upsert_template_field_transforms(*, template_id: str, groups: list[FieldTransformGroupInput]) -> list[FieldTransformStep]:
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    assert normalized_template_id is not None

    with _get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM template_field_transforms WHERE template_id = %s", (normalized_template_id,))

            for group in groups:
                for step_order, step in enumerate(group.steps, start=1):
                    cur.execute(
                        """
                        INSERT INTO template_field_transforms (
                          transform_id, template_id, field_key, step_order, operation,
                          param_from, param_to, param_chars, param_delimiter, param_index,
                          param_case, param_date_output
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            str(uuid.uuid4()),
                            normalized_template_id,
                            group.field_key,
                            step_order,
                            step.operation,
                            step.param_from,
                            step.param_to,
                            step.param_chars,
                            step.param_delimiter,
                            step.param_index,
                            step.param_case,
                            step.param_date_output,
                        ),
                    )
        conn.commit()

    return list_template_field_transforms(template_id=normalized_template_id)


def serialize_field_transforms(steps: list[FieldTransformStep]) -> list[dict]:
    by_field: dict[str, list[FieldTransformStep]] = {}
    for step in steps:
        by_field.setdefault(step.field_key, []).append(step)

    out: list[dict] = []
    for field_key in sorted(by_field.keys()):
        sorted_steps = sorted(by_field[field_key], key=lambda item: item.step_order)
        out_steps: list[dict] = []
        for step in sorted_steps:
            payload = {
                "operation": step.operation,
            }
            if step.operation == "replace":
                payload["from"] = step.param_from or ""
                payload["to"] = step.param_to or ""
            elif step.operation == "remove_chars":
                payload["chars"] = step.param_chars or ""
            elif step.operation == "split":
                payload["delimiter"] = step.param_delimiter or ""
                payload["index"] = step.param_index or 1
            elif step.operation == "case":
                payload["mode"] = step.param_case or "lower"
            elif step.operation == "date_format":
                payload["output"] = step.param_date_output or "YYYY"
            out_steps.append(payload)
        out.append({"field_key": field_key, "steps": out_steps})
    return out


def _parse_date_components(raw_value: str) -> tuple[int | None, int | None, int | None] | None:
    text = " ".join(raw_value.strip().split())
    if not text:
        return None

    compact = text.replace(".", "/").replace("-", "/")

    match_full = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", compact)
    if match_full:
        day = int(match_full.group(1))
        month = int(match_full.group(2))
        year = int(match_full.group(3))
        return day, month, year

    match_ymd = re.fullmatch(r"(\d{4})/(\d{1,2})/(\d{1,2})", compact)
    if match_ymd:
        year = int(match_ymd.group(1))
        month = int(match_ymd.group(2))
        day = int(match_ymd.group(3))
        return day, month, year

    match_my = re.fullmatch(r"(\d{1,2})/(\d{4})", compact)
    if match_my:
        month = int(match_my.group(1))
        year = int(match_my.group(2))
        return None, month, year

    match_y = re.fullmatch(r"(\d{4})", compact)
    if match_y:
        return None, None, int(match_y.group(1))

    normalized = text.casefold().replace(",", " ").replace("-", " ").replace("/", " ")
    normalized = " ".join(normalized.split())

    match_month_year = re.fullmatch(r"([a-záéíóúñ]+)\s+(\d{4})", normalized)
    if match_month_year:
        month_name = match_month_year.group(1)
        year = int(match_month_year.group(2))
        month = SPANISH_MONTHS.get(month_name)
        if month:
            return None, month, year

    match_day_month_year = re.fullmatch(r"(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})", normalized)
    if match_day_month_year:
        day = int(match_day_month_year.group(1))
        month_name = match_day_month_year.group(2)
        year = int(match_day_month_year.group(3))
        month = SPANISH_MONTHS.get(month_name)
        if month:
            return day, month, year

    return None


def _assert_date_parts(day: int | None, month: int | None, year: int | None, *, output: str, field_key: str) -> None:
    if output == "DD" and day is None:
        raise ValueError(f"Field '{field_key}' date format '{output}' requires day component")
    if output in {"MM", "MM/YYYY", "YYYY-MM", "MMM", "MMMM"} and month is None:
        raise ValueError(f"Field '{field_key}' date format '{output}' requires month component")
    if output in {"YYYY", "MM/YYYY", "YYYY-MM"} and year is None:
        raise ValueError(f"Field '{field_key}' date format '{output}' requires year component")


def _format_date(day: int | None, month: int | None, year: int | None, output: str) -> str:
    if output == "DD":
        assert day is not None
        return f"{day:02d}"
    if output == "MM":
        assert month is not None
        return f"{month:02d}"
    if output == "YYYY":
        assert year is not None
        return f"{year:04d}"
    if output == "MM/YYYY":
        assert month is not None and year is not None
        return f"{month:02d}/{year:04d}"
    if output == "YYYY-MM":
        assert month is not None and year is not None
        return f"{year:04d}-{month:02d}"
    if output == "MMM":
        assert month is not None
        return MONTH_ABBR[month]
    if output == "MMMM":
        assert month is not None
        return MONTH_FULL[month]
    raise ValueError(f"Unsupported date output format '{output}'")


def apply_transform_step(value: str, step: FieldTransformStepInput, *, field_key: str) -> str:
    current = str(value or "")
    if not current.strip():
        return ""

    op = step.operation
    if op == "trim":
        return current.strip()

    if op == "replace":
        needle = step.param_from or ""
        if not needle:
            raise ValueError(f"Field '{field_key}' replace requires non-empty 'from'")
        return current.replace(needle, step.param_to or "")

    if op == "remove_chars":
        chars = step.param_chars or ""
        if not chars:
            raise ValueError(f"Field '{field_key}' remove_chars requires non-empty 'chars'")
        remove_set = set(chars)
        return "".join(ch for ch in current if ch not in remove_set)

    if op == "split":
        delimiter = step.param_delimiter or ""
        if not delimiter:
            raise ValueError(f"Field '{field_key}' split requires non-empty delimiter")
        index = int(step.param_index or 0)
        if index < 1:
            raise ValueError(f"Field '{field_key}' split index must be >= 1")
        parts = current.split(delimiter)
        if index > len(parts):
            raise ValueError(
                f"Field '{field_key}' split index {index} out of range for value '{current}'"
            )
        return parts[index - 1]

    if op == "case":
        mode = (step.param_case or "").lower()
        if mode not in VALID_CASE_MODES:
            raise ValueError(f"Field '{field_key}' case mode is invalid")
        if mode == "upper":
            return current.upper()
        if mode == "lower":
            return current.lower()
        return current.title()

    if op == "date_format":
        output = (step.param_date_output or "").upper()
        if output not in VALID_DATE_OUTPUT_FORMATS:
            raise ValueError(f"Field '{field_key}' date output format is invalid")
        parsed = _parse_date_components(current)
        if not parsed:
            raise ValueError(f"Field '{field_key}' could not parse date from '{current}'")
        day, month, year = parsed
        _assert_date_parts(day, month, year, output=output, field_key=field_key)
        return _format_date(day, month, year, output)

    raise ValueError(f"Field '{field_key}' transform '{op}' is not supported")


def apply_transform_pipeline(value: str, steps: list[FieldTransformStepInput], *, field_key: str) -> tuple[str, list[str]]:
    current = str(value or "")
    snapshots = [current]
    for step in steps:
        current = apply_transform_step(current, step, field_key=field_key)
        snapshots.append(current)
    return current, snapshots


def apply_field_transforms_to_value_map(
    *,
    value_map: dict[str, str],
    groups: list[FieldTransformGroupInput],
) -> tuple[dict[str, str], dict[str, list[str]]]:
    updated = dict(value_map)
    snapshots_by_field: dict[str, list[str]] = {}
    for group in groups:
        original = str(updated.get(group.field_key, ""))
        transformed, snapshots = apply_transform_pipeline(original, group.steps, field_key=group.field_key)
        updated[group.field_key] = transformed
        snapshots_by_field[group.field_key] = snapshots
    return updated, snapshots_by_field
