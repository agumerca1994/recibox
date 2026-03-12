from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime

from app.db.postgres import get_postgres_conn
from app.services.templates.field_transforms import (
    FieldTransformGroupInput,
    list_template_field_transforms,
    list_template_field_transforms_map,
    parse_field_transforms_payload,
    serialize_field_transforms,
    upsert_template_field_transforms,
)

VALID_TEMPLATE_TARGETS = {"ignore", "employee_folder", "year_folder", "filename"}
VALID_DOCUMENT_FIELD_TYPES = {"string", "number", "date", "array"}
VALID_TEMPLATE_MODES = {"processing", "document"}


@dataclass
class DocumentTemplate:
    template_id: str
    tenant_id: str
    name: str
    description: str | None
    is_active: bool
    original_model: dict
    custom_model: dict
    sample_file_metadata: dict | None
    field_transforms: list[dict]
    created_at: datetime
    updated_at: datetime


def init_document_templates_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS document_templates (
                  template_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  description TEXT NULL,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  original_model JSONB NOT NULL,
                  custom_model JSONB NOT NULL,
                  sample_file_metadata JSONB NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_document_templates_tenant_updated
                ON document_templates (tenant_id, updated_at DESC)
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_document_templates_tenant_lower_updated
                ON document_templates ((LOWER(tenant_id)), updated_at DESC)
                """
            )
        conn.commit()


def _normalize_text(value: str | None, field: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if required and not normalized:
        raise ValueError(f"{field} is required")
    return normalized or None


def _normalize_tenant_id(value: str | None) -> str:
    normalized = _normalize_text(value, "tenant_id", required=True)
    assert normalized is not None
    return normalized.lower()


def resolve_template_mode(custom_model: dict | None) -> str:
    payload = custom_model or {}
    mode = str(payload.get("mode", "")).strip().lower()
    if mode in VALID_TEMPLATE_MODES:
        return mode

    raw_fields = payload.get("fields")
    if not isinstance(raw_fields, list):
        return "processing"
    for item in raw_fields:
        if not isinstance(item, dict):
            continue
        if "rect" in item or "name" in item or "type" in item:
            return "document"
        if "target" in item or "selected" in item:
            return "processing"
    return "processing"


def _normalize_key_candidate(value: str, fallback: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in value.lower())
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    cleaned = cleaned.strip("_")
    return cleaned or fallback


def _clamp_unit(value: object, field: str) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be numeric")
    if numeric < 0:
        return 0.0
    if numeric > 1:
        return 1.0
    return numeric


def _normalize_processing_custom_model(payload: dict) -> dict:
    raw_fields = payload.get("fields")
    if not isinstance(raw_fields, list):
        raise ValueError("custom_model.fields must be a list")

    normalized_fields: list[dict] = []
    seen_keys: set[str] = set()
    useful_count = 0
    for index, item in enumerate(raw_fields):
        if not isinstance(item, dict):
            raise ValueError(f"custom_model.fields[{index}] must be an object")
        key = str(item.get("key", "")).strip()
        if not key:
            raise ValueError(f"custom_model.fields[{index}].key is required")
        if key in seen_keys:
            raise ValueError(f"custom_model.fields contains duplicate key '{key}'")
        seen_keys.add(key)

        label = str(item.get("label", key)).strip() or key
        selected = bool(item.get("selected", False))
        target = str(item.get("target", "ignore")).strip()
        if target not in VALID_TEMPLATE_TARGETS:
            raise ValueError(
                "custom_model.fields[%d].target must be one of: %s"
                % (index, ", ".join(sorted(VALID_TEMPLATE_TARGETS)))
            )
        required = bool(item.get("required", False))
        if selected and target != "ignore":
            useful_count += 1

        normalized_fields.append(
            {
                "key": key,
                "label": label,
                "selected": selected,
                "target": target,
                "required": required,
            }
        )

    if useful_count == 0:
        raise ValueError("custom_model must include at least one selected field with a target")

    return {"mode": "processing", "fields": normalized_fields}


def _normalize_document_custom_model(payload: dict) -> dict:
    raw_fields = payload.get("fields")
    if not isinstance(raw_fields, list):
        raise ValueError("custom_model.fields must be a list")
    if not raw_fields:
        raise ValueError("custom_model.fields must include at least one item")

    normalized_fields: list[dict] = []
    seen_keys: set[str] = set()
    for index, item in enumerate(raw_fields):
        if not isinstance(item, dict):
            raise ValueError(f"custom_model.fields[{index}] must be an object")
        field_name = str(item.get("name", "")).strip() or str(item.get("field", "")).strip()
        if not field_name:
            raise ValueError(f"custom_model.fields[{index}].name is required")

        key_raw = str(item.get("key", "")).strip()
        key = _normalize_key_candidate(key_raw or field_name, f"field_{index + 1}")
        if not key:
            raise ValueError(f"custom_model.fields[{index}].key is required")
        if key in seen_keys:
            raise ValueError(f"custom_model.fields contains duplicate key '{key}'")
        seen_keys.add(key)

        field_type = str(item.get("type", "string")).strip().lower()
        if field_type not in VALID_DOCUMENT_FIELD_TYPES:
            field_type = "string"

        rect = item.get("rect")
        if not isinstance(rect, dict):
            raise ValueError(f"custom_model.fields[{index}].rect is required")
        x = _clamp_unit(rect.get("x"), f"custom_model.fields[{index}].rect.x")
        y = _clamp_unit(rect.get("y"), f"custom_model.fields[{index}].rect.y")
        w = _clamp_unit(rect.get("w"), f"custom_model.fields[{index}].rect.w")
        h = _clamp_unit(rect.get("h"), f"custom_model.fields[{index}].rect.h")
        if w <= 0 or h <= 0:
            raise ValueError(f"custom_model.fields[{index}].rect must have positive size")

        field_id = str(item.get("id", "")).strip() or str(uuid.uuid4())
        label = _normalize_text(item.get("label"), f"custom_model.fields[{index}].label")
        suggested_label = _normalize_text(item.get("suggested_label"), f"custom_model.fields[{index}].suggested_label")
        detected_value = _normalize_text(item.get("detected_value"), f"custom_model.fields[{index}].detected_value")
        sample_value = _normalize_text(item.get("sample_value"), f"custom_model.fields[{index}].sample_value")

        normalized_fields.append(
            {
                "id": field_id,
                "key": key,
                "name": field_name,
                "label": label,
                "suggested_label": suggested_label,
                "type": field_type,
                "rect": {
                    "page": 1,
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                },
                "detected_value": detected_value,
                "sample_value": sample_value,
                "required": bool(item.get("required", False)),
            }
        )

    return {"mode": "document", "fields": normalized_fields}


def _normalize_custom_model(custom_model: dict | None) -> dict:
    payload = custom_model or {}
    if not isinstance(payload, dict):
        raise ValueError("custom_model must be an object")
    mode = resolve_template_mode(payload)
    if mode == "document":
        return _normalize_document_custom_model(payload)
    return _normalize_processing_custom_model(payload)


def _normalize_original_model(original_model: dict | None) -> dict:
    payload = original_model or {}
    if not isinstance(payload, dict):
        raise ValueError("original_model must be an object")
    fields = payload.get("fields")
    if fields is None:
        payload = dict(payload)
        payload["fields"] = []
        return payload
    if not isinstance(fields, list):
        raise ValueError("original_model.fields must be a list")
    return payload


def _normalize_sample_file_metadata(sample_file_metadata: dict | None) -> dict | None:
    if sample_file_metadata is None:
        return None
    if not isinstance(sample_file_metadata, dict):
        raise ValueError("sample_file_metadata must be an object")
    return sample_file_metadata


def _extract_document_field_keys(custom_model: dict | None) -> set[str]:
    payload = custom_model or {}
    fields = payload.get("fields") if isinstance(payload, dict) else None
    if not isinstance(fields, list):
        return set()

    out: set[str] = set()
    for item in fields:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()
        if key:
            out.add(key)
    return out


def _normalize_field_transforms(
    field_transforms: list[dict] | None,
    *,
    custom_model: dict,
) -> list[FieldTransformGroupInput]:
    mode = resolve_template_mode(custom_model)
    if mode != "document":
        if field_transforms not in (None, []):
            raise ValueError("field_transforms is only supported for document templates")
        return []

    available_field_keys = _extract_document_field_keys(custom_model)
    return parse_field_transforms_payload(field_transforms, available_field_keys=available_field_keys)


def _row_to_template(row) -> DocumentTemplate:
    return DocumentTemplate(
        template_id=row[0],
        tenant_id=row[1],
        name=row[2],
        description=row[3],
        is_active=row[4],
        original_model=row[5],
        custom_model=row[6],
        sample_file_metadata=row[7],
        field_transforms=[],
        created_at=row[8],
        updated_at=row[9],
    )


def _attach_field_transforms(templates: list[DocumentTemplate]) -> list[DocumentTemplate]:
    if not templates:
        return templates

    transforms_by_template = list_template_field_transforms_map(
        template_ids=[template.template_id for template in templates],
    )
    for template in templates:
        steps = transforms_by_template.get(template.template_id, [])
        template.field_transforms = serialize_field_transforms(steps)
    return templates


def list_document_templates(*, tenant_id: str, include_inactive: bool = True) -> list[DocumentTemplate]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    query = """
        SELECT template_id, tenant_id, name, description, is_active, original_model, custom_model,
               sample_file_metadata, created_at, updated_at
        FROM document_templates
        WHERE LOWER(tenant_id) = %s
    """
    params: list[object] = [normalized_tenant]
    if not include_inactive:
        query += " AND is_active = TRUE"
    query += " ORDER BY updated_at DESC, name ASC"

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()
    return _attach_field_transforms([_row_to_template(row) for row in rows])


def get_document_template(*, tenant_id: str, template_id: str) -> DocumentTemplate | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT template_id, tenant_id, name, description, is_active, original_model, custom_model,
                       sample_file_metadata, created_at, updated_at
                FROM document_templates
                WHERE LOWER(tenant_id) = %s AND template_id = %s
                """,
                (normalized_tenant, normalized_template_id),
            )
            row = cur.fetchone()
    if not row:
        return None
    template = _row_to_template(row)
    steps = list_template_field_transforms(template_id=template.template_id)
    template.field_transforms = serialize_field_transforms(steps)
    return template


def create_document_template(
    *,
    tenant_id: str,
    name: str,
    description: str | None,
    original_model: dict,
    custom_model: dict,
    sample_file_metadata: dict | None = None,
    field_transforms: list[dict] | None = None,
    is_active: bool = True,
) -> DocumentTemplate:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_description = _normalize_text(description, "description")
    normalized_original = _normalize_original_model(original_model)
    normalized_custom = _normalize_custom_model(custom_model)
    normalized_field_transforms = _normalize_field_transforms(
        field_transforms,
        custom_model=normalized_custom,
    )
    normalized_sample = _normalize_sample_file_metadata(sample_file_metadata)
    template_id = str(uuid.uuid4())

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO document_templates (
                  template_id, tenant_id, name, description, is_active,
                  original_model, custom_model, sample_file_metadata
                )
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
                RETURNING template_id, tenant_id, name, description, is_active, original_model, custom_model,
                          sample_file_metadata, created_at, updated_at
                """,
                (
                    template_id,
                    normalized_tenant,
                    normalized_name,
                    normalized_description,
                    bool(is_active),
                    json.dumps(normalized_original),
                    json.dumps(normalized_custom),
                    json.dumps(normalized_sample) if normalized_sample is not None else None,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    upsert_template_field_transforms(template_id=template_id, groups=normalized_field_transforms)
    template = _row_to_template(row)
    template.field_transforms = serialize_field_transforms(
        list_template_field_transforms(template_id=template.template_id)
    )
    return template


def update_document_template(
    *,
    tenant_id: str,
    template_id: str,
    name: str,
    description: str | None,
    original_model: dict,
    custom_model: dict,
    sample_file_metadata: dict | None = None,
    field_transforms: list[dict] | None = None,
    is_active: bool = True,
) -> DocumentTemplate | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    normalized_name = _normalize_text(name, "name", required=True)
    normalized_description = _normalize_text(description, "description")
    normalized_original = _normalize_original_model(original_model)
    normalized_custom = _normalize_custom_model(custom_model)
    normalized_field_transforms = (
        _normalize_field_transforms(field_transforms, custom_model=normalized_custom)
        if field_transforms is not None
        else None
    )
    normalized_sample = _normalize_sample_file_metadata(sample_file_metadata)

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE document_templates
                SET
                  name = %s,
                  description = %s,
                  is_active = %s,
                  original_model = %s::jsonb,
                  custom_model = %s::jsonb,
                  sample_file_metadata = %s::jsonb,
                  updated_at = NOW()
                WHERE LOWER(tenant_id) = %s AND template_id = %s
                RETURNING template_id, tenant_id, name, description, is_active, original_model, custom_model,
                          sample_file_metadata, created_at, updated_at
                """,
                (
                    normalized_name,
                    normalized_description,
                    bool(is_active),
                    json.dumps(normalized_original),
                    json.dumps(normalized_custom),
                    json.dumps(normalized_sample) if normalized_sample is not None else None,
                    normalized_tenant,
                    normalized_template_id,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        return None
    if normalized_field_transforms is not None:
        upsert_template_field_transforms(
            template_id=normalized_template_id,
            groups=normalized_field_transforms,
        )
    else:
        mode = resolve_template_mode(normalized_custom)
        if mode != "document":
            upsert_template_field_transforms(template_id=normalized_template_id, groups=[])
        else:
            available_field_keys = _extract_document_field_keys(normalized_custom)
            existing_serialized = serialize_field_transforms(
                list_template_field_transforms(template_id=normalized_template_id)
            )
            filtered_payload = [
                item
                for item in existing_serialized
                if str(item.get("field_key", "")).strip() in available_field_keys
            ]
            reconciled_groups = parse_field_transforms_payload(
                filtered_payload,
                available_field_keys=available_field_keys,
            )
            upsert_template_field_transforms(
                template_id=normalized_template_id,
                groups=reconciled_groups,
            )
    template = _row_to_template(row)
    template.field_transforms = serialize_field_transforms(
        list_template_field_transforms(template_id=template.template_id)
    )
    return template


def delete_document_template(*, tenant_id: str, template_id: str) -> bool:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM document_templates WHERE LOWER(tenant_id) = %s AND template_id = %s",
                (normalized_tenant, normalized_template_id),
            )
            deleted = cur.rowcount > 0
        conn.commit()
    return deleted


def delete_legacy_templates_by_name(*, template_names: list[str]) -> int:
    normalized_names = [name.strip().lower() for name in template_names if str(name or "").strip()]
    if not normalized_names:
        return 0

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM document_templates
                WHERE LOWER(name) = ANY(%s)
                  AND COALESCE(LOWER(custom_model->>'mode'), 'processing') <> 'document'
                """,
                (normalized_names,),
            )
            deleted = cur.rowcount or 0
        conn.commit()
    return int(deleted)
