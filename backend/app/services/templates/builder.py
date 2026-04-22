from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
import re

from app.core.config import settings
from app.services.pdf.extractor import extract_text_from_pdf, parse_fields
from app.services.storage import gdrive

FIELD_LABELS = {
    "empleado": "Empleado",
    "cuit": "CUIT/CUIL",
    "legajo": "Legajo",
    "fecha": "Fecha",
    "mes": "Mes",
    "anio": "Anio",
    "fecha_pago": "Fecha de pago",
}

FIELD_ORDER = ["empleado", "cuit", "legajo", "fecha", "mes", "anio", "fecha_pago"]
MODEL_SCHEMA_VERSION = "1"
MAX_RAW_LINE_FIELDS = 120
PAYROLL_FREQUENCY_WORDS = {
    "MENSUAL",
    "QUINCENAL",
    "SEMANAL",
    "DIARIO",
    "JORNAL",
    "ANUAL",
}


def _build_fields(info: dict[str, str | None]) -> list[dict]:
    fields: list[dict] = []
    for key in FIELD_ORDER:
        value = info.get(key)
        fields.append(
            {
                "key": key,
                "label": FIELD_LABELS.get(key, key.replace("_", " ").title()),
                "value": "" if value in (None, "") else str(value),
                "source": "parse_fields",
            }
        )
    return fields


def _build_raw_text_fields(text: str) -> list[dict]:
    fields: list[dict] = []
    seen: set[str] = set()
    field_index = 1
    lines = [line.rstrip() for line in text.splitlines()]
    for raw_line in lines:
        for segment in _split_line_into_field_candidates(raw_line):
            normalized = segment.strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            fields.append(
                {
                    "key": f"raw_field_{field_index:03d}",
                    "label": f"Campo {field_index}",
                    "value": normalized,
                    "source": "raw_text",
                }
            )
            field_index += 1
            if len(fields) >= MAX_RAW_LINE_FIELDS:
                return fields
    return fields


def _split_line_into_field_candidates(line: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", (line or "").strip())
    if not normalized:
        return []

    deduped = _dedupe_repeated_token_sequence(normalized)
    explicit_parts = [
        part.strip()
        for part in re.split(r"\s{2,}|\t+|\s+\|\s+|\s+;\s+", deduped)
        if part.strip()
    ]
    if len(explicit_parts) > 1:
        return explicit_parts

    semantic_parts = _split_semantic_fields(deduped)
    if len(semantic_parts) > 1:
        return semantic_parts

    return [deduped]


def _dedupe_repeated_token_sequence(value: str) -> str:
    tokens = value.split()
    count = len(tokens)
    if count >= 2 and count % 2 == 0:
        half = count // 2
        if tokens[:half] == tokens[half:]:
            return " ".join(tokens[:half])
    return value


def _split_semantic_fields(value: str) -> list[str]:
    by_frequency = _split_company_and_frequency(value)
    if len(by_frequency) > 1:
        return by_frequency

    by_address = _split_address_and_city(value)
    if len(by_address) > 1:
        return by_address

    by_key_value = _split_key_value_suffix(value)
    if len(by_key_value) > 1:
        return by_key_value

    return [value]


def _split_company_and_frequency(value: str) -> list[str]:
    tokens = value.split()
    if len(tokens) < 2:
        return [value]

    last = tokens[-1].upper()
    if last in PAYROLL_FREQUENCY_WORDS:
        left = " ".join(tokens[:-1]).strip()
        right = tokens[-1].strip()
        if left and right:
            return [left, right]
    return [value]


def _split_address_and_city(value: str) -> list[str]:
    match = re.match(
        r"^(.+?\b\d{1,6})\s+([A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){0,2})$",
        value,
    )
    if not match:
        return [value]
    left = match.group(1).strip()
    right = match.group(2).strip()
    if left and right:
        return [left, right]
    return [value]


def _split_key_value_suffix(value: str) -> list[str]:
    match = re.match(r"^([A-ZÁÉÍÓÚÜÑ0-9 .,'/-]{2,}):\s+(.+)$", value)
    if not match:
        return [value]
    left = match.group(1).strip()
    right = match.group(2).strip()
    if left and right:
        return [left, right]
    return [value]


def build_original_model(*, file_id: str, file_name: str, text: str, info) -> dict:
    info_dict = asdict(info)
    parsed_fields = _build_fields(info_dict)
    raw_text_fields = _build_raw_text_fields(text)
    return {
        "schema_version": MODEL_SCHEMA_VERSION,
        "sample": {
            "file_id": file_id,
            "file_name": file_name,
        },
        "source": {
            "extractor": "extract_text_from_pdf",
            "parser": "parse_fields",
        },
        "extracted_info": info_dict,
        "fields": parsed_fields + raw_text_fields,
        "raw_text": text,
        "raw_text_len": len(text),
    }


def build_template_draft_for_file(file_id: str, *, tenant_id: str, file_name: str | None = None) -> dict:
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"template-{tenant_id}-{file_id}.pdf"

    try:
        gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
        text = extract_text_from_pdf(str(local_path))
        info = parse_fields(text)
        file_name_value = (file_name or f"{file_id}.pdf").strip() or f"{file_id}.pdf"
        original_model = build_original_model(
            file_id=file_id,
            file_name=file_name_value,
            text=text,
            info=info,
        )
        custom_model = {
            "fields": [
                {
                    "key": field["key"],
                    "label": field["label"],
                    "selected": False,
                    "target": "ignore",
                    "required": False,
                }
                for field in original_model["fields"]
            ]
        }
        return {
            "file_id": file_id,
            "file_name": file_name_value,
            "original_model": original_model,
            "custom_model": custom_model,
        }
    finally:
        try:
            local_path.unlink(missing_ok=True)
        except Exception:
            pass
