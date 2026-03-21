from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path

import pdfplumber
from rq import get_current_job

from app.core.config import settings
from app.queue import get_redis
from app.services.pdf.extractor import extract_text_from_pdf, parse_fields
from app.services.processing.results import ProcessResult, write_result
from app.services.storage import gdrive
from app.services.templates.classification_rules import (
    ClassificationRule,
    ClassificationRuleNode,
    DocumentFieldDefinition,
    evaluate_classification_rule_status,
    extract_document_field_definitions,
    get_classification_rule,
)
from app.services.templates.field_transforms import (
    FieldTransformGroupInput,
    apply_field_transforms_to_value_map,
    parse_field_transforms_payload,
)
from app.services.templates.store import get_document_template, resolve_template_mode
from app.services.tenants.drive_config import resolve_tenant_drive_config


def _update_current_job_progress(
    *,
    processed: int,
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
            "ok": max(int(ok or 0), 0),
            "error": max(int(error or 0), 0),
            "status": str(status or "").strip() or "running",
            "message": str(message or "").strip() or None,
        }
        job.save_meta()
    except Exception:
        return


def _clamp_unit(value: object) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    if numeric < 0:
        return 0.0
    if numeric > 1:
        return 1.0
    return numeric


def _rect_intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    ax2 = a["x"] + a["w"]
    ay2 = a["y"] + a["h"]
    bx2 = b["x"] + b["w"]
    by2 = b["y"] + b["h"]
    return a["x"] < bx2 and ax2 > b["x"] and a["y"] < by2 and ay2 > b["y"]


def _detect_text_by_rect(tokens: list[dict[str, float | str]], rect: dict[str, float]) -> str:
    selected = [
        token
        for token in tokens
        if _rect_intersects(
            rect,
            {
                "x": float(token["x"]),
                "y": float(token["y"]),
                "w": float(token["w"]),
                "h": float(token["h"]),
            },
        )
    ]

    selected.sort(
        key=lambda token: (
            round(float(token["y"]) / 0.008),
            float(token["x"]),
        )
    )

    if not selected:
        return ""

    lines: list[str] = []
    current_line = ""
    current_y = float(selected[0]["y"])
    for token in selected:
        token_text = str(token.get("text", "")).strip()
        if not token_text:
            continue
        token_y = float(token["y"])
        if abs(token_y - current_y) > 0.01:
            if current_line.strip():
                lines.append(re.sub(r"\s+", " ", current_line.strip()))
            current_line = token_text
            current_y = token_y
            continue
        current_line = f"{current_line} {token_text}".strip()

    if current_line.strip():
        lines.append(re.sub(r"\s+", " ", current_line.strip()))

    return "\n".join(lines).strip()


def _extract_tokens_from_first_page(local_pdf_path: Path) -> list[dict[str, float | str]]:
    with pdfplumber.open(str(local_pdf_path)) as pdf:
        if not pdf.pages:
            return []

        page = pdf.pages[0]
        page_width = float(page.width or 1.0)
        page_height = float(page.height or 1.0)
        words = page.extract_words(keep_blank_chars=False, use_text_flow=True)

    tokens: list[dict[str, float | str]] = []
    for item in words:
        text = str(item.get("text", "")).strip()
        if not text:
            continue

        x0 = float(item.get("x0", 0.0))
        x1 = float(item.get("x1", 0.0))
        top = float(item.get("top", 0.0))
        bottom = float(item.get("bottom", 0.0))

        width = max(x1 - x0, 0.0)
        height = max(bottom - top, 0.0)
        if width <= 0 or height <= 0:
            continue

        token = {
            "text": text,
            "x": _clamp_unit(x0 / page_width),
            "y": _clamp_unit(top / page_height),
            "w": _clamp_unit(width / page_width),
            "h": _clamp_unit(height / page_height),
        }
        tokens.append(token)

    return tokens


def _extract_document_field_rects(custom_model: dict | None) -> list[dict[str, object]]:
    payload = custom_model or {}
    fields = payload.get("fields") if isinstance(payload, dict) else None
    if not isinstance(fields, list):
        return []

    out: list[dict[str, object]] = []
    for item in fields:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()
        if not key:
            continue

        rect_raw = item.get("rect")
        if not isinstance(rect_raw, dict):
            continue

        rect = {
            "x": _clamp_unit(rect_raw.get("x", 0)),
            "y": _clamp_unit(rect_raw.get("y", 0)),
            "w": _clamp_unit(rect_raw.get("w", 0)),
            "h": _clamp_unit(rect_raw.get("h", 0)),
        }
        if rect["w"] <= 0 or rect["h"] <= 0:
            continue

        out.append(
            {
                "key": key,
                "name": str(item.get("name", key)).strip() or key,
                "required": bool(item.get("required", False)),
                "rect": rect,
            }
        )

    return out


def _extract_document_values(local_pdf_path: Path, custom_model: dict | None) -> dict[str, str]:
    tokens = _extract_tokens_from_first_page(local_pdf_path)
    fields = _extract_document_field_rects(custom_model)
    out: dict[str, str] = {}

    for field in fields:
        key = str(field["key"])
        rect = field["rect"]
        assert isinstance(rect, dict)
        detected = _detect_text_by_rect(tokens, rect)
        value = re.sub(r"\s+", " ", detected).strip()
        out[key] = value

    return out


def _sanitize_drive_name(value: str, fallback: str) -> str:
    normalized = re.sub(r"[\\:*?\"<>|]+", "-", value)
    normalized = re.sub(r"\s+", " ", normalized).strip(" .")
    return normalized or fallback


def _normalize_match_name(value: str) -> str:
    return " ".join(value.strip().casefold().split())


def _resolve_field_requirements(field_definitions: list[DocumentFieldDefinition]) -> set[str]:
    return {item.key for item in field_definitions if item.required}


def _to_index_numeric(alpha_value: str) -> int:
    return ord(alpha_value.upper()) - ord("A")


def _from_index_numeric(value: int) -> str:
    return chr(ord("A") + value)


def _extract_index_values_from_existing_names(
    *,
    node: ClassificationRuleNode,
    target_part_order: int,
    value_map: dict[str, str],
    existing_names: list[str],
) -> list[int]:
    target_part = node.name_parts[target_part_order]
    target_kind = str(target_part.index_kind or "").strip().lower()
    if target_kind not in {"numeric", "alphabetic"}:
        return []

    def build_pattern(*, strict_fields: bool) -> re.Pattern[str] | None:
        pattern_parts: list[str] = []
        capture_group = ""
        for part_index, part in enumerate(node.name_parts):
            if part.part_type == "literal":
                literal = _sanitize_drive_name(str(part.literal_value or ""), "")
                pattern_parts.append(re.escape(literal))
                continue
            if part.part_type == "field":
                if strict_fields:
                    field_value = str(value_map.get(str(part.field_key or "").strip(), "")).strip()
                    pattern_parts.append(re.escape(_sanitize_drive_name(field_value, "")))
                else:
                    pattern_parts.append(r".*?")
                continue

            kind = str(part.index_kind or "").strip().lower()
            token = r"\d{1,4}" if kind == "numeric" else r"[A-Za-z]"
            if part_index == target_part_order:
                capture_group = token
                pattern_parts.append(f"({token})")
            else:
                pattern_parts.append(token)

        if not capture_group:
            return None
        return re.compile("^" + "".join(pattern_parts) + "$", re.IGNORECASE)

    def collect_values(regex: re.Pattern[str]) -> list[int]:
        out: list[int] = []
        for name in existing_names:
            candidates = [name]
            if node.node_type == "file" and name.lower().endswith(".pdf"):
                candidates.append(name[:-4])

            for candidate in candidates:
                match = regex.match(candidate)
                if not match:
                    continue
                token = str(match.group(1) or "").strip()
                if not token:
                    continue
                if target_kind == "numeric":
                    try:
                        parsed = int(token)
                    except ValueError:
                        continue
                    if 0 <= parsed <= 9999:
                        out.append(parsed)
                else:
                    alpha = token.upper()
                    if len(alpha) == 1 and "A" <= alpha <= "Z":
                        out.append(_to_index_numeric(alpha))
        return out

    strict_regex = build_pattern(strict_fields=True)
    strict_values = collect_values(strict_regex) if strict_regex else []
    if strict_values:
        return strict_values

    relaxed_regex = build_pattern(strict_fields=False)
    return collect_values(relaxed_regex) if relaxed_regex else []


def _resolve_index_part_value(
    *,
    node: ClassificationRuleNode,
    part_order: int,
    value_map: dict[str, str],
    existing_names: list[str],
) -> str:
    part = node.name_parts[part_order]
    index_kind = str(part.index_kind or "").strip().lower()
    index_direction = str(part.index_direction or "").strip().lower()
    if index_kind not in {"numeric", "alphabetic"}:
        raise RuntimeError("index_kind invalido")
    if index_direction not in {"incremental", "decremental"}:
        raise RuntimeError("index_direction invalido")

    if index_kind == "numeric":
        if part.index_start_numeric is None:
            if index_direction == "decremental":
                raise RuntimeError("Indice numerico decremental requiere valor inicial (0-9999)")
            start = 0
        else:
            start = int(part.index_start_numeric)
        if start < 0 or start > 9999:
            raise RuntimeError("index_start_numeric fuera de rango (0-9999)")
        detected_values = _extract_index_values_from_existing_names(
            node=node,
            target_part_order=part_order,
            value_map=value_map,
            existing_names=existing_names,
        )
        if detected_values:
            next_value = (max(detected_values) + 1) if index_direction == "incremental" else (min(detected_values) - 1)
        else:
            next_value = start
        if next_value < 0 or next_value > 9999:
            raise RuntimeError("Indice numerico fuera de rango (0-9999)")
        return str(next_value)

    if part.index_start_alpha is None:
        if index_direction == "decremental":
            raise RuntimeError("Indice alfabetico decremental requiere valor inicial (A-Z)")
        alpha_start = "A"
    else:
        alpha_start = str(part.index_start_alpha).strip().upper()
    if len(alpha_start) != 1 or not ("A" <= alpha_start <= "Z"):
        raise RuntimeError("index_start_alpha fuera de rango (A-Z)")
    start_alpha_numeric = _to_index_numeric(alpha_start)
    detected_values = _extract_index_values_from_existing_names(
        node=node,
        target_part_order=part_order,
        value_map=value_map,
        existing_names=existing_names,
    )
    if detected_values:
        next_value = (max(detected_values) + 1) if index_direction == "incremental" else (min(detected_values) - 1)
    else:
        next_value = start_alpha_numeric
    if next_value < 0 or next_value > 25:
        raise RuntimeError("Indice alfabetico fuera de rango (A-Z)")
    return _from_index_numeric(next_value)


def _render_node_name(
    node: ClassificationRuleNode,
    *,
    value_map: dict[str, str],
    required_keys: set[str],
    existing_names: list[str],
) -> tuple[str, list[str]]:
    parts: list[str] = []
    missing_required: list[str] = []

    for part_index, part in enumerate(node.name_parts):
        if part.part_type == "literal":
            parts.append(str(part.literal_value or ""))
            continue
        if part.part_type == "field":
            key = str(part.field_key or "").strip()
            value = str(value_map.get(key, "")).strip()
            if not value:
                if key in required_keys:
                    missing_required.append(key)
                continue
            parts.append(value)
            continue

        # Dynamic index part. Value is auto-resolved from existing names in the same parent.
        parts.append(
            _resolve_index_part_value(
                node=node,
                part_order=part_index,
                value_map=value_map,
                existing_names=existing_names,
            )
        )

    raw_name = "".join(parts)
    sanitized = _sanitize_drive_name(raw_name, "")
    return sanitized, missing_required


def _list_child_folders(parent_id: str, *, tenant_id: str) -> list[dict]:
    query = "mimeType = 'application/vnd.google-apps.folder'"
    return list(gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id))


def _list_child_files(parent_id: str, *, tenant_id: str) -> list[dict]:
    query = "mimeType != 'application/vnd.google-apps.folder'"
    return list(gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id))


def _list_child_names(parent_id: str, *, item_type: str, tenant_id: str) -> list[str]:
    if item_type == "folder":
        return [str(item.get("name", "")).strip() for item in _list_child_folders(parent_id, tenant_id=tenant_id)]
    return [str(item.get("name", "")).strip() for item in _list_child_files(parent_id, tenant_id=tenant_id)]


def _get_cached_child_names(
    *,
    cache: dict[tuple[str, str], list[str]],
    parent_id: str,
    item_type: str,
    tenant_id: str,
) -> list[str]:
    key = (parent_id, item_type)
    if key not in cache:
        cache[key] = _list_child_names(parent_id, item_type=item_type, tenant_id=tenant_id)
    return cache[key]


def _remember_child_name(
    *,
    cache: dict[tuple[str, str], list[str]],
    parent_id: str,
    item_type: str,
    name: str,
) -> None:
    key = (parent_id, item_type)
    if key not in cache:
        cache[key] = []
    cache[key].append(name)


def _resolve_folder_by_policy(
    *,
    parent_id: str,
    folder_name: str,
    conflict_policy: str,
    tenant_id: str,
) -> tuple[dict, bool]:
    if conflict_policy == "create_new":
        return gdrive.create_folder(parent_id, folder_name, tenant_id=tenant_id), True

    existing = _list_child_folders(parent_id, tenant_id=tenant_id)
    normalized_target = _normalize_match_name(folder_name)
    matches = [folder for folder in existing if _normalize_match_name(str(folder.get("name", ""))) == normalized_target]

    if len(matches) == 1:
        return matches[0], False
    if len(matches) > 1:
        raise RuntimeError(
            "Ambiguous existing folders for '%s' under parent '%s'" % (folder_name, parent_id)
        )
    return gdrive.create_folder(parent_id, folder_name, tenant_id=tenant_id), True


def _build_mixed_value_map(*, extracted_values: dict[str, str], fallback_values: dict[str, str]) -> dict[str, str]:
    merged: dict[str, str] = {}
    for key, value in fallback_values.items():
        normalized = str(value or "").strip()
        if normalized:
            merged[str(key)] = normalized

    for key, value in extracted_values.items():
        normalized = str(value or "").strip()
        if normalized:
            merged[str(key)] = normalized
        else:
            merged.setdefault(str(key), "")

    return merged


def _process_one_template_document(
    file_meta: dict,
    *,
    tenant_id: str,
    drive_root_folder_id: str,
    template,
    classification_rule: ClassificationRule,
    field_definitions: list[DocumentFieldDefinition],
    field_transform_groups: list[FieldTransformGroupInput],
    child_name_cache: dict[tuple[str, str], list[str]] | None = None,
) -> ProcessResult:
    file_id = str(file_meta.get("id", "")).strip()
    file_name = str(file_meta.get("name", "")).strip()
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"template-run-{tenant_id}-{file_id}.pdf"

    if not file_id:
        return ProcessResult(file_id="unknown", status="error", message="File metadata without id")

    try:
        gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
    except Exception as exc:
        return ProcessResult(file_id=file_id, status="error", message="Download failed", error=str(exc))

    try:
        text = extract_text_from_pdf(str(local_path))
        info = parse_fields(text)
        fallback_values = {
            key: str(value).strip()
            for key, value in asdict(info).items()
            if value not in (None, "")
        }
        extracted_values = _extract_document_values(local_path, template.custom_model)
        value_map = _build_mixed_value_map(extracted_values=extracted_values, fallback_values=fallback_values)
        if field_transform_groups:
            value_map, _ = apply_field_transforms_to_value_map(
                value_map=value_map,
                groups=field_transform_groups,
            )
        required_keys = _resolve_field_requirements(field_definitions)
        ordered_nodes = sorted(classification_rule.nodes, key=lambda item: item.node_order)
    except Exception as exc:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Template classification failed",
            info=info if "info" in locals() else None,
            error=str(exc),
        )

    current_parent_id = drive_root_folder_id
    resolved_folders: list[str] = []
    target_filename = ""
    effective_child_name_cache = child_name_cache if child_name_cache is not None else {}
    missing_required_keys: list[str] = []
    try:
        for node in ordered_nodes:
            item_type = "folder" if node.node_type == "folder" else "file"
            existing_names = _get_cached_child_names(
                cache=effective_child_name_cache,
                parent_id=current_parent_id,
                item_type=item_type,
                tenant_id=tenant_id,
            )
            rendered_name, missing_keys = _render_node_name(
                node,
                value_map=value_map,
                required_keys=required_keys,
                existing_names=existing_names,
            )
            if missing_keys:
                missing_required_keys.extend(missing_keys)
            if not rendered_name:
                node_label = "archivo" if node.node_type == "file" else "carpeta"
                raise RuntimeError(f"No se pudo construir el nombre de {node_label} para el nodo {node.node_order}")

            if node.node_type == "folder":
                policy = node.conflict_policy or "use_existing"
                folder, created_new = _resolve_folder_by_policy(
                    parent_id=current_parent_id,
                    folder_name=rendered_name,
                    conflict_policy=policy,
                    tenant_id=tenant_id,
                )
                if created_new:
                    _remember_child_name(
                        cache=effective_child_name_cache,
                        parent_id=current_parent_id,
                        item_type="folder",
                        name=rendered_name,
                    )
                current_parent_id = str(folder.get("id", "")).strip()
                resolved_folders.append(str(folder.get("name", rendered_name)))
                if not current_parent_id:
                    raise RuntimeError("Drive folder resolution returned empty id")
                continue

            target_filename = rendered_name
            if not target_filename.lower().endswith(".pdf"):
                target_filename = f"{target_filename}.pdf"

        unique_missing = sorted(set(item for item in missing_required_keys if item))
        if unique_missing:
            raise RuntimeError("Faltan campos requeridos para clasificar: %s" % ", ".join(unique_missing))
        if not target_filename:
            raise RuntimeError("No se pudo construir el nombre de archivo")

        gdrive.move_and_rename(file_id, current_parent_id, target_filename, tenant_id=tenant_id)
        _remember_child_name(
            cache=effective_child_name_cache,
            parent_id=current_parent_id,
            item_type="file",
            name=target_filename,
        )
    except Exception as exc:
        return ProcessResult(
            file_id=file_id,
            status="error",
            message="Drive move/rename failed",
            info=info if "info" in locals() else None,
            target={
                "folders": resolved_folders,
                "new_filename": target_filename,
            },
            error=str(exc),
        )
    finally:
        try:
            local_path.unlink(missing_ok=True)
        except Exception:
            pass

    return ProcessResult(
        file_id=file_id,
        status="ok",
        message=f"Processed with template and moved: {file_name}",
        info=info if "info" in locals() else None,
        target={
            "folders": resolved_folders,
            "new_filename": target_filename,
            "template_id": template.template_id,
            "classification_rule_id": classification_rule.rule_id,
        },
    )


def _resolve_template_flow_files(
    *,
    tenant_id: str,
    input_folder_id: str,
    selected_file_ids: list[str] | None,
) -> list[dict]:
    if not selected_file_ids:
        return list(
            gdrive.list_files_in_folder(
                input_folder_id,
                query_extra="mimeType = 'application/pdf'",
                tenant_id=tenant_id,
            )
        )

    selected_files: list[dict] = []
    seen_ids: set[str] = set()
    for raw_file_id in selected_file_ids:
        file_id = str(raw_file_id or "").strip()
        if not file_id or file_id in seen_ids:
            continue
        seen_ids.add(file_id)
        try:
            file_meta = gdrive.get_file_metadata(
                file_id,
                tenant_id=tenant_id,
                fields="id, name, mimeType, parents, createdTime, modifiedTime",
            )
        except Exception:
            continue

        parents = file_meta.get("parents") or []
        if file_meta.get("mimeType") != "application/pdf" or input_folder_id not in parents:
            continue
        selected_files.append(file_meta)

    return selected_files


def run_template_flow(*, tenant_id: str, template_id: str, file_ids: list[str] | None = None, limit: int = 50) -> dict:
    lock_key = f"recibox:lock:{tenant_id}"
    redis_conn = get_redis()

    try:
        cfg = resolve_tenant_drive_config(redis_conn, tenant_id)
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
        if not template:
            return {"status": "error", "message": "Template not found"}
        if not template.is_active:
            return {"status": "error", "message": "Template is inactive"}
        if resolve_template_mode(template.custom_model) != "document":
            return {"status": "error", "message": "Template is not compatible with document mode"}

        rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
        field_definitions = extract_document_field_definitions(template.custom_model)
        available_field_keys = {item.key for item in field_definitions}
        field_transform_groups = parse_field_transforms_payload(
            template.field_transforms,
            available_field_keys=available_field_keys,
        )
        rule_status, rule_errors = evaluate_classification_rule_status(rule=rule, field_definitions=field_definitions)
        if rule_status != "ready":
            if rule_status == "missing":
                return {"status": "error", "message": "Template has no classification rule"}
            details = "; ".join(rule_errors) if rule_errors else "invalid classification rule"
            return {"status": "error", "message": f"Template classification rule is invalid: {details}"}

        assert rule is not None
    except Exception as exc:
        return {"status": "error", "message": f"Template config failed: {exc}"}

    try:
        files = _resolve_template_flow_files(
            tenant_id=tenant_id,
            input_folder_id=cfg.drive_input_folder_id,
            selected_file_ids=file_ids,
        )
    except Exception as exc:
        return {"status": "error", "message": f"List failed: {exc}"}

    try:
        if not files:
            return {"status": "ok", "message": "No PDFs found", "processed": 0}

        total = min(len(files), limit)
        ok = 0
        err = 0
        _update_current_job_progress(processed=0, ok=0, error=0, status="running", message="Proceso en curso")
        shared_child_name_cache: dict[tuple[str, str], list[str]] = {}
        for index, file_meta in enumerate(files[:total], start=1):
            result = _process_one_template_document(
                file_meta,
                tenant_id=tenant_id,
                drive_root_folder_id=cfg.recibox_folder_id,
                template=template,
                classification_rule=rule,
                field_definitions=field_definitions,
                field_transform_groups=field_transform_groups,
                child_name_cache=shared_child_name_cache,
            )
            write_result(result, settings.results_log_path)
            if result.status == "ok":
                ok += 1
            else:
                err += 1
            _update_current_job_progress(
                processed=index,
                ok=ok,
                error=err,
                status="running",
                message=result.message or "Proceso en curso",
            )

        final_status = "ok" if err == 0 else "partial"
        _update_current_job_progress(
            processed=total,
            ok=ok,
            error=err,
            status=final_status,
            message="Proceso finalizado" if err == 0 else "Proceso finalizado con errores",
        )

        return {
            "status": final_status,
            "processed": total,
            "ok": ok,
            "error": err,
            "log": settings.results_log_path,
            "template_id": template_id,
            "rule_id": rule.rule_id,
            "file_ids_count": len(file_ids or []),
        }
    finally:
        try:
            redis_conn.delete(lock_key)
        except Exception:
            pass
