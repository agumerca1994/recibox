from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from pathlib import Path
import json
from urllib.parse import quote, unquote_plus
import uuid
from pydantic import BaseModel
from rq.command import send_stop_job_command
from rq.job import Job

from app.queue import get_queue, get_redis
from app.core.config import settings
from app.workers.flow_job import run_flow
from app.services.process_runs import (
    list_recent_process_runs,
    mark_process_run_paused,
    serialize_job_status,
    serialize_process_run,
    upsert_process_run,
)
from app.services.reports import (
    bind_report_file_template,
    create_report_layout,
    create_report_run,
    delete_report_layout,
    get_report_layout,
    get_report_run,
    list_recent_report_runs,
    list_report_layouts,
    normalize_report_run_options,
    parse_report_columns_payload,
    resolve_report_selection,
    run_report_flow,
    serialize_report_layout,
    serialize_report_run,
    sync_report_run,
    update_report_layout,
)
from app.services.templates.builder import build_template_draft_for_file
from app.services.templates.drive_folders import ensure_template_group_drive_folder
from app.services.templates.processor import run_template_flow
from app.services.templates.groups import (
    create_template_group,
    ensure_template_group_name_available,
    get_template_group,
    get_template_groups_map,
    list_template_groups,
    update_template_group_drive_folder_id,
)
from app.services.templates.store import (
    create_document_template,
    delete_document_template,
    get_document_template,
    list_document_templates,
    resolve_template_mode,
    update_document_template,
)
from app.services.templates.classification_rules import (
    evaluate_classification_rule_status,
    extract_document_field_definitions,
    get_classification_rule,
    list_classification_rules_for_templates,
    parse_classification_rule_payload,
    serialize_classification_rule,
    upsert_classification_rule,
    validate_classification_rule_against_fields,
)
from app.services.templates.source_pdf import (
    delete_template_source_pdf,
    resolve_template_source_pdf,
    save_template_source_pdf,
)
from app.services.storage import gdrive
from app.services.storage.gdrive_ops import (
    ensure_employee_folder,
    ensure_year_folder,
    list_employee_folders,
    list_year_folders,
)
from app.services.auth import google_oauth, oauth_state
from app.services.auth.principal import (
    Principal,
    ensure_principal_has_roles,
    ensure_principal_matches_tenant,
    require_principal,
    require_user_principal,
)
from app.services.auth.rate_limit import enforce_rate_limit, get_request_ip
from app.services.auth.service_tokens import (
    create_service_token,
    list_service_tokens,
    revoke_service_token,
)
from app.services.tenants.drive_config import (
    clear_tenant_drive_config,
    is_tenant_disabled,
    load_tenant_drive_config,
    resolve_tenant_drive_config,
    save_tenant_drive_config,
    set_tenant_disabled,
)
from app.services.tenants.user_profiles import upsert_user_profile
from app.services.tenants.processing_preferences import (
    clear_tenant_processing_preferences,
    load_tenant_processing_preferences,
    resolve_tenant_processing_preferences,
    save_tenant_processing_preferences,
)

router = APIRouter()


class TenantDriveConfigPayload(BaseModel):
    drive_input_folder_id: str
    drive_root_folder_id: str
    drive_recibox_folder_id: str | None = None


class CreateDriveFolderPayload(BaseModel):
    parent_id: str
    name: str


class CreateReciboxStructurePayload(BaseModel):
    parent_id: str


class CreateReciboxInputPayload(BaseModel):
    recibox_folder_id: str
    root_parent_id: str | None = None


class AdoptReciboxFolderPayload(BaseModel):
    folder_id: str
    parent_id: str = "root"


class CreateEmployeePayload(BaseModel):
    employee_name: str


class CreateEmployeeYearPayload(BaseModel):
    year: str


class FilenameCustomFormatPayload(BaseModel):
    part1: str = "MM"
    sep1: str = "-"
    part2: str = "YYYY"
    sep2: str = ")"
    part3: str = "EMPLOYEE"


class ProcessingPreferencesPayload(BaseModel):
    filename_format_mode: str
    filename_custom_format: FilenameCustomFormatPayload | None = None
    employee_folder_number_mode: str = "indexed_number"
    employee_folder_number_custom_part1: str | None = None
    employee_folder_number_custom_part2: str | None = None
    auto_create_missing_employee_folder: bool = True


class IngestDrivePayload(BaseModel):
    processing_mode: str = "default"
    template_id: str | None = None
    file_ids: list[str] | None = None


class TemplateDraftFromFilePayload(BaseModel):
    file_id: str
    file_name: str | None = None


class TemplatePayload(BaseModel):
    name: str
    group_id: str
    description: str | None = None
    is_active: bool = True
    original_model: dict
    custom_model: dict
    sample_file_metadata: dict | None = None
    field_transforms: list[dict] | None = None


class TemplateGroupPayload(BaseModel):
    name: str


class ClassificationRuleNamePartPayload(BaseModel):
    part_type: str
    field_key: str | None = None
    literal_value: str | None = None
    index_kind: str | None = None
    index_start_numeric: int | None = None
    index_start_alpha: str | None = None
    index_direction: str | None = None


class ClassificationRuleNodePayload(BaseModel):
    node_type: str
    conflict_policy: str | None = None
    name_parts: list[ClassificationRuleNamePartPayload]


class ClassificationRulePayload(BaseModel):
    nodes: list[ClassificationRuleNodePayload]


class RegisterUserPayload(BaseModel):
    company_name: str
    tax_id: str
    billing_address: str
    email: str | None = None


class OAuthStartPayload(BaseModel):
    popup: bool = False


class ServiceTokenCreatePayload(BaseModel):
    name: str
    scopes: list[str]
    expires_in_days: int = 90


class ReportColumnPayload(BaseModel):
    column_id: str | None = None
    label: str
    value_type: str = "string"
    source_type: str
    system_key: str | None = None
    template_mappings: dict[str, str] | None = None
    order: int | None = None


class ReportLayoutPayload(BaseModel):
    name: str
    description: str | None = None
    default_group_id: str
    default_output_format: str = "csv"
    csv_delimiter: str = ";"
    columns: list[ReportColumnPayload]
    is_active: bool = True


class ReportSelectionResolvePayload(BaseModel):
    group_id: str
    file_ids: list[str]


class ReportFileTemplateBindingPayload(BaseModel):
    group_id: str
    template_id: str


class ReportRunCreatePayload(BaseModel):
    report_id: str | None = None
    group_id: str
    file_ids: list[str]
    output_format: str = "csv"
    csv_delimiter: str = ";"
    columns: list[ReportColumnPayload]


class ReportRunReprocessPayload(BaseModel):
    output_format: str | None = None
    csv_delimiter: str | None = None


def _ensure_tenant_active(tenant_id: str) -> None:
    redis_conn = get_redis()
    if is_tenant_disabled(redis_conn, tenant_id):
        raise HTTPException(
            status_code=403,
            detail=f"Tenant '{tenant_id}' is unlinked. Re-link OAuth to continue.",
        )


def _resolve_drive_config_or_400(tenant_id: str):
    redis_conn = get_redis()
    try:
        return resolve_tenant_drive_config(redis_conn, tenant_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _ensure_postgres_enabled() -> None:
    if not settings.postgres_url:
        raise HTTPException(status_code=503, detail="Postgres is required for this operation")


def _resolve_template_rule_metadata(template, rule) -> tuple[str, bool, list[str]]:
    if not str(getattr(template, "group_id", "") or "").strip():
        return "invalid", rule is not None, ["Template group is required"]
    field_definitions = extract_document_field_definitions(template.custom_model)
    rule_status, rule_errors = evaluate_classification_rule_status(
        rule=rule,
        field_definitions=field_definitions,
    )
    has_rule = rule_status != "missing"
    return rule_status, has_rule, rule_errors


def _serialize_template_group(group) -> dict:
    return {
        "group_id": group.group_id,
        "tenant_id": group.tenant_id,
        "name": group.name,
        "drive_folder_id": group.drive_folder_id,
        "created_at": group.created_at,
        "updated_at": group.updated_at,
    }


def _sync_template_group_drive_folder_if_needed(group):
    try:
        folder = ensure_template_group_drive_folder(
            tenant_id=group.tenant_id,
            group_name=group.name,
            drive_folder_id=group.drive_folder_id,
        )
    except Exception:
        return group

    synced_folder_id = str(folder.get("id", "")).strip()
    if not synced_folder_id or synced_folder_id == str(group.drive_folder_id or "").strip():
        return group

    updated_group = update_template_group_drive_folder_id(
        tenant_id=group.tenant_id,
        group_id=group.group_id,
        drive_folder_id=synced_folder_id,
    )
    return updated_group or group


def _serialize_template_summary_payload(
    *,
    template,
    group_name: str | None,
    rule_status: str,
    has_rule: bool,
) -> dict:
    return {
        "template_id": template.template_id,
        "tenant_id": template.tenant_id,
        "name": template.name,
        "group_id": template.group_id,
        "group_name": group_name,
        "description": template.description,
        "is_active": template.is_active,
        "template_mode": resolve_template_mode(template.custom_model),
        "sample_file_metadata": template.sample_file_metadata,
        "drive_folder_id": template.drive_folder_id,
        "field_transforms": template.field_transforms,
        "rule_status": rule_status,
        "has_rule": has_rule,
        "updated_at": template.updated_at,
    }


def _serialize_template_detail_payload(
    *,
    template,
    group_name: str | None,
    rule_status: str,
    has_rule: bool,
    rule_errors: list[str] | None = None,
    serialized_rule: dict | None = None,
) -> dict:
    payload = _serialize_template_summary_payload(
        template=template,
        group_name=group_name,
        rule_status=rule_status,
        has_rule=has_rule,
    )
    payload.update(
        {
            "original_model": template.original_model,
            "custom_model": template.custom_model,
            "rule_errors": rule_errors or [],
            "classification_rule": serialized_rule,
            "created_at": template.created_at,
        }
    )
    return payload


def _serialize_report_columns_payload(columns: list[ReportColumnPayload]) -> list[dict]:
    return [item.model_dump() for item in columns]


def _popup_origin_from_request(request: Request) -> str | None:
    origin = str(request.headers.get("origin") or "").strip()
    if origin:
        return origin
    referer = str(request.headers.get("referer") or "").strip()
    if not referer:
        return None
    try:
        from urllib.parse import urlsplit

        parsed = urlsplit(referer)
    except Exception:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/auth/session")
async def auth_session(
    _request: Request,
    principal: Principal | None = Depends(require_user_principal(require_tenant_match=False)),
):
    if principal is None:
        raise HTTPException(status_code=401, detail="Missing authenticated user")
    return {
        "uid": principal.uid,
        "email": principal.email,
        "tenant_id": principal.tenant_id,
        "roles": list(principal.roles),
    }


@router.post("/auth/register")
async def register_user(
    payload: RegisterUserPayload,
    _request: Request,
    principal: Principal | None = Depends(require_user_principal(require_tenant_match=False)),
):
    if principal is None or not principal.uid:
        raise HTTPException(status_code=401, detail="Missing authenticated user")
    uid = principal.uid
    token_email = principal.email
    tenant_id = principal.tenant_id
    profile_email = (payload.email or token_email or "").strip() or None
    try:
        profile = upsert_user_profile(
            uid=uid,
            tenant_id=tenant_id,
            email=profile_email,
            company_name=payload.company_name,
            tax_id=payload.tax_id,
            billing_address=payload.billing_address,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Profile save failed: {exc}")

    return {
        "status": "ok",
        "uid": profile.uid,
        "tenant_id": profile.tenant_id,
        "email": profile.email,
        "roles": list(principal.roles),
        "company_name": profile.company_name,
        "tax_id": profile.tax_id,
        "billing_address": profile.billing_address,
    }

@router.get("/drive/files")
async def list_drive_files(
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        files = list(
            gdrive.list_files_in_folder(
                cfg.drive_input_folder_id,
                query_extra="mimeType = 'application/pdf'",
                tenant_id=tenant_id,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/employees")
async def list_employee_folders_endpoint(
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        folders = list_employee_folders(cfg.recibox_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.post("/drive/employees")
async def create_employee_folder(
    payload: CreateEmployeePayload,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    employee_name = payload.employee_name.strip()
    if not employee_name:
        raise HTTPException(status_code=400, detail="employee_name is required")
    cfg = _resolve_drive_config_or_400(tenant_id)
    try:
        folder = ensure_employee_folder(cfg.recibox_folder_id, employee_name, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create employee folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.get("/drive/employees/{employee_folder_id}/years")
async def list_employee_years(
    employee_folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        folders = list_year_folders(employee_folder_id, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "folders": folders}

    return {"count": min(len(folders), limit), "folders": folders[:limit]}


@router.post("/drive/employees/{employee_folder_id}/years")
async def create_employee_year_folder(
    employee_folder_id: str,
    payload: CreateEmployeeYearPayload,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    year = payload.year.strip()
    if not year:
        raise HTTPException(status_code=400, detail="year is required")
    try:
        folder = ensure_year_folder(employee_folder_id, year, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create year folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.get("/drive/employees/{employee_folder_id}/files")
async def list_employee_files(
    employee_folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        files = list(gdrive.list_files_in_folder(employee_folder_id, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/folders/{folder_id}/files")
async def list_files_in_folder_endpoint(
    folder_id: str,
    limit: int | None = Query(None, ge=1, le=1000),
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    compact_fields = "nextPageToken, files(id, name, mimeType)"
    try:
        files = list(
            gdrive.list_files_in_folder(
                folder_id,
                tenant_id=tenant_id,
                query_extra="mimeType != 'application/vnd.google-apps.folder'",
                fields=compact_fields,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(files), "files": files}

    return {"count": min(len(files), limit), "files": files[:limit]}


@router.get("/drive/folders/{folder_id}/contents")
async def list_folder_contents_endpoint(
    folder_id: str,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    folder_mime = "application/vnd.google-apps.folder"
    compact_fields = "nextPageToken, files(id, name, mimeType)"
    try:
        items = list(
            gdrive.list_files_in_folder(
                folder_id,
                tenant_id=tenant_id,
                fields=compact_fields,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    folders = [item for item in items if item.get("mimeType") == folder_mime]
    files = [item for item in items if item.get("mimeType") != folder_mime]
    return {
        "folder_id": folder_id,
        "folders_count": len(folders),
        "files_count": len(files),
        "folders": folders,
        "files": files,
    }


@router.get("/drive/picker/folders")
async def list_picker_folders(
    tenant_id: str = Query("default"),
    parent_id: str = Query("root"),
    limit: int | None = Query(None, ge=1, le=1000),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    query = "mimeType = 'application/vnd.google-apps.folder'"
    compact_fields = "nextPageToken, files(id, name, mimeType)"
    try:
        folders = list(
            gdrive.list_files_in_folder(
                parent_id,
                query_extra=query,
                tenant_id=tenant_id,
                fields=compact_fields,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    if limit is None:
        return {"count": len(folders), "parent_id": parent_id, "folders": folders}

    return {
        "count": min(len(folders), limit),
        "parent_id": parent_id,
        "folders": folders[:limit],
    }


@router.post("/drive/picker/folders")
async def create_picker_folder(
    payload: CreateDriveFolderPayload,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    name = payload.name.strip()
    if not payload.parent_id.strip():
        raise HTTPException(status_code=400, detail="parent_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        folder = gdrive.create_folder(payload.parent_id.strip(), name, tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create folder failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "folder": folder}


@router.post("/drive/picker/recibox-structure")
async def create_recibox_structure(
    payload: CreateReciboxStructurePayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    parent_id = payload.parent_id.strip()
    if not parent_id:
        raise HTTPException(status_code=400, detail="parent_id is required")
    try:
        recibox_folder = gdrive.ensure_folder(parent_id, "RECIBOX", tenant_id=tenant_id)
        input_folder = gdrive.ensure_folder(recibox_folder["id"], "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create structure failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=parent_id,
            drive_recibox_folder_id=recibox_folder["id"],
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "parent_id": parent_id,
        "root_folder": recibox_folder,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.get("/drive/picker/recibox-structure/check")
async def check_recibox_structure(
    tenant_id: str = Query("default"),
    parent_id: str = Query("root"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    parent = parent_id.strip()
    if not parent:
        raise HTTPException(status_code=400, detail="parent_id is required")

    try:
        recibox_folder = gdrive.find_folder_by_name(parent, "RECIBOX", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Check structure failed: {exc}")

    if not recibox_folder:
        return {
            "status": "missing_recibox",
            "parent_id": parent,
            "recibox_exists": False,
            "input_exists": False,
            "recibox_folder_id": None,
            "input_folder_id": None,
        }

    try:
        input_folder = gdrive.find_folder_by_name(recibox_folder["id"], "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Check structure failed: {exc}")

    if not input_folder:
        return {
            "status": "missing_input",
            "parent_id": parent,
            "recibox_exists": True,
            "input_exists": False,
            "recibox_folder_id": recibox_folder["id"],
            "input_folder_id": None,
        }

    return {
        "status": "complete",
        "parent_id": parent,
        "recibox_exists": True,
        "input_exists": True,
        "recibox_folder_id": recibox_folder["id"],
        "input_folder_id": input_folder["id"],
    }


@router.post("/drive/picker/recibox-input")
async def create_recibox_input(
    payload: CreateReciboxInputPayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    recibox_folder_id = payload.recibox_folder_id.strip()
    if not recibox_folder_id:
        raise HTTPException(status_code=400, detail="recibox_folder_id is required")

    try:
        input_folder = gdrive.ensure_folder(recibox_folder_id, "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create input folder failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        current_cfg = load_tenant_drive_config(redis_conn, tenant_id)
        fallback_root = (settings.drive_root_folder_id or "").strip()
        root_parent_id = (payload.root_parent_id or "").strip() or (
            current_cfg.drive_root_folder_id if current_cfg else fallback_root or recibox_folder_id
        )
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=root_parent_id,
            drive_recibox_folder_id=recibox_folder_id,
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "recibox_folder_id": recibox_folder_id,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.post("/drive/picker/recibox-structure/adopt-folder")
async def adopt_recibox_folder(
    payload: AdoptReciboxFolderPayload,
    tenant_id: str = Query("default"),
    save_as_tenant_config: bool = Query(True),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    _ensure_tenant_active(tenant_id)
    folder_id = payload.folder_id.strip()
    parent_id = payload.parent_id.strip() or "root"
    if not folder_id:
        raise HTTPException(status_code=400, detail="folder_id is required")

    query = "mimeType = 'application/vnd.google-apps.folder'"
    try:
        root_folders = list(gdrive.list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    selected_folder = next((folder for folder in root_folders if folder.get("id") == folder_id), None)
    if not selected_folder:
        raise HTTPException(status_code=404, detail="Selected folder was not found in parent")

    existing_recibox = next(
        (
            folder
            for folder in root_folders
            if folder.get("name") == "RECIBOX" and folder.get("id") != folder_id
        ),
        None,
    )
    if existing_recibox:
        raise HTTPException(status_code=409, detail="A different RECIBOX folder already exists in parent")

    try:
        recibox_folder = gdrive.update_file_metadata(
            folder_id,
            tenant_id=tenant_id,
            new_name="RECIBOX",
        )
        input_folder = gdrive.ensure_folder(folder_id, "#0 INPUT", tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Adopt folder failed: {exc}")

    updated_config = None
    if save_as_tenant_config:
        redis_conn = get_redis()
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=input_folder["id"],
            drive_root_folder_id=parent_id,
            drive_recibox_folder_id=recibox_folder["id"],
        )
        set_tenant_disabled(redis_conn, tenant_id, False)
        updated_config = {
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "parent_id": parent_id,
        "root_folder": recibox_folder,
        "input_folder": input_folder,
        "tenant_config_updated": bool(updated_config),
        "tenant_config": updated_config,
    }


@router.get("/drive/files/{file_id}/download")
async def download_drive_file(
    file_id: str,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    _ensure_tenant_active(tenant_id)
    cfg = _resolve_drive_config_or_400(tenant_id)
    if not gdrive.file_has_any_ancestor(
        file_id,
        ancestor_ids=[
            cfg.drive_input_folder_id,
            cfg.drive_recibox_folder_id,
        ],
        tenant_id=tenant_id,
    ):
        raise HTTPException(status_code=403, detail="File is outside allowed tenant folders")
    local_dir = Path(settings.local_download_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / f"{file_id}.pdf"
    try:
        gdrive.download_file(file_id, str(local_path), tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Download failed: {exc}")

    if not local_path.exists() or local_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Downloaded file is empty or missing")

    return FileResponse(
        path=str(local_path),
        media_type="application/pdf",
        filename=f"{file_id}.pdf",
    )

@router.post("/ingest/drive")
async def ingest_drive(
    payload: IngestDrivePayload | None = None,
    tenant_id: str = Query("default"),
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"})),
):
    _ensure_tenant_active(tenant_id)
    enforce_rate_limit(
        bucket="jobs_run",
        subject=str(tenant_id),
        limit=settings.rate_limit_job_run_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    redis_conn = get_redis()
    cfg = _resolve_drive_config_or_400(tenant_id)
    lock_key = f"recibox:lock:{tenant_id}"
    effective_payload = payload or IngestDrivePayload()
    processing_mode = (effective_payload.processing_mode or "default").strip().lower()
    template_id = (effective_payload.template_id or "").strip() or None
    selected_file_ids = [
        str(file_id or "").strip()
        for file_id in (effective_payload.file_ids or [])
        if str(file_id or "").strip()
    ]

    if processing_mode not in {"default", "template"}:
        raise HTTPException(status_code=400, detail="Unsupported processing mode")
    if processing_mode == "default" and not settings.enable_legacy_processing_flow:
        raise HTTPException(status_code=400, detail="Legacy processing flow is disabled")

    # Prevent concurrent runs for same tenant.
    if not redis_conn.set(lock_key, "1", nx=True, ex=60 * 60):
        raise HTTPException(status_code=409, detail="Processing already running for tenant")

    q = get_queue()
    template_name: str | None = None
    process_name = "Proceso flujo actual"
    if processing_mode == "template":
        if not template_id:
            redis_conn.delete(lock_key)
            raise HTTPException(status_code=400, detail="template_id is required when processing_mode=template")
        try:
            template = get_document_template(tenant_id=tenant_id, template_id=template_id)
        except Exception as exc:
            redis_conn.delete(lock_key)
            raise HTTPException(status_code=500, detail=f"Template lookup failed: {exc}")
        if not template:
            redis_conn.delete(lock_key)
            raise HTTPException(status_code=400, detail="Template not found")
        if not template.is_active:
            redis_conn.delete(lock_key)
            raise HTTPException(status_code=400, detail="Template is inactive")
        if resolve_template_mode(template.custom_model) != "document":
            redis_conn.delete(lock_key)
            raise HTTPException(status_code=400, detail="Template is not compatible with document mode")

        template_name = template.name
        process_name = f"Proceso {template.name}"
        rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
        rule_status, _, _ = _resolve_template_rule_metadata(template, rule)
        if rule_status != "ready":
            redis_conn.delete(lock_key)
            if rule_status == "missing":
                raise HTTPException(status_code=400, detail="Template has no classification rule")
            raise HTTPException(status_code=400, detail="Template classification rule is invalid")
        job = q.enqueue(
            run_template_flow,
            tenant_id=tenant_id,
            template_id=template_id,
            file_ids=selected_file_ids or None,
            job_timeout=settings.rq_job_timeout_seconds,
        )
    else:
        job = q.enqueue(run_flow, tenant_id=tenant_id, job_timeout=settings.rq_job_timeout_seconds)
    job.meta["tenant_id"] = tenant_id
    job.meta["processing_mode"] = processing_mode
    if template_id:
        job.meta["template_id"] = template_id
    if template_name:
        job.meta["template_name"] = template_name
    job.meta["process_name"] = process_name
    if selected_file_ids:
        job.meta["file_ids_count"] = len(selected_file_ids)
    job.meta["progress"] = {
        "processed": 0,
        "ok": 0,
        "error": 0,
        "status": "running",
        "message": "Proceso en curso",
    }
    job.save_meta()
    if settings.postgres_url:
        try:
            upsert_process_run(
                job_id=job.id,
                tenant_id=tenant_id,
                processing_mode=processing_mode,
                template_id=template_id,
                template_name=template_name,
                file_ids_count=len(selected_file_ids),
                name=process_name,
                status="running",
                detail=serialize_job_status(job),
            )
        except Exception:
            pass
    return {
        "status": "queued",
        "job_id": job.id,
        "tenant_id": tenant_id,
        "drive_config_source": cfg.source,
        "processing_mode": processing_mode,
        "template_id": template_id,
        "file_ids_count": len(selected_file_ids),
    }


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    principal: Principal | None = Depends(require_principal(scopes={"jobs:run"}, require_tenant_match=False)),
):
    try:
        job = Job.fetch(job_id, connection=get_redis())
    except Exception:
        raise HTTPException(status_code=404, detail="Job not found")
    if principal is not None:
        ensure_principal_matches_tenant(principal, job.meta.get("tenant_id"))
    return serialize_job_status(job)


@router.get("/process-runs")
async def get_process_runs(
    tenant_id: str = Query("default"),
    limit: int = Query(10, ge=1, le=10),
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"})),
):
    if not settings.postgres_url:
        return {"count": 0, "items": []}
    items = [serialize_process_run(record) for record in list_recent_process_runs(tenant_id, limit=limit)]
    return {"count": len(items), "items": items}


@router.post("/tenants/{tenant_id}/reports/selection/resolve")
async def resolve_report_selection_endpoint(
    tenant_id: str,
    payload: ReportSelectionResolvePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    _ensure_tenant_active(tenant_id)
    try:
        resolved = resolve_report_selection(
            tenant_id=tenant_id,
            group_id=payload.group_id,
            file_ids=payload.file_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Report selection resolve failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, **resolved}


@router.put("/tenants/{tenant_id}/reports/files/{file_id}/template-binding")
async def bind_report_file_template_endpoint(
    tenant_id: str,
    file_id: str,
    payload: ReportFileTemplateBindingPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    _ensure_tenant_active(tenant_id)
    try:
        result = bind_report_file_template(
            tenant_id=tenant_id,
            group_id=payload.group_id,
            file_id=file_id,
            template_id=payload.template_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Template binding failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "binding": result}


@router.get("/tenants/{tenant_id}/reports")
async def get_report_layouts_endpoint(
    tenant_id: str,
    include_inactive: bool = Query(True),
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    try:
        layouts = list_report_layouts(tenant_id=tenant_id, include_inactive=include_inactive)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List report layouts failed: {exc}")
    return {
        "tenant_id": tenant_id,
        "count": len(layouts),
        "reports": [serialize_report_layout(item) for item in layouts],
    }


@router.post("/tenants/{tenant_id}/reports")
async def post_report_layout(
    tenant_id: str,
    payload: ReportLayoutPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    if not get_template_group(tenant_id=tenant_id, group_id=payload.default_group_id):
        raise HTTPException(status_code=400, detail="Template group not found")
    try:
        layout = create_report_layout(
            tenant_id=tenant_id,
            name=payload.name,
            description=payload.description,
            default_group_id=payload.default_group_id,
            default_output_format=payload.default_output_format,
            csv_delimiter=payload.csv_delimiter,
            columns=_serialize_report_columns_payload(payload.columns),
            is_active=payload.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create report layout failed: {exc}")
    return {"status": "ok", "tenant_id": tenant_id, "report": serialize_report_layout(layout)}


@router.get("/tenants/{tenant_id}/reports/{report_id}")
async def get_report_layout_endpoint(
    tenant_id: str,
    report_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    try:
        layout = get_report_layout(tenant_id=tenant_id, report_id=report_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get report layout failed: {exc}")
    if layout is None:
        raise HTTPException(status_code=404, detail="Report layout not found")
    return serialize_report_layout(layout)


@router.put("/tenants/{tenant_id}/reports/{report_id}")
async def put_report_layout_endpoint(
    tenant_id: str,
    report_id: str,
    payload: ReportLayoutPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    if not get_template_group(tenant_id=tenant_id, group_id=payload.default_group_id):
        raise HTTPException(status_code=400, detail="Template group not found")
    try:
        layout = update_report_layout(
            tenant_id=tenant_id,
            report_id=report_id,
            name=payload.name,
            description=payload.description,
            default_group_id=payload.default_group_id,
            default_output_format=payload.default_output_format,
            csv_delimiter=payload.csv_delimiter,
            columns=_serialize_report_columns_payload(payload.columns),
            is_active=payload.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Update report layout failed: {exc}")
    if layout is None:
        raise HTTPException(status_code=404, detail="Report layout not found")
    return {"status": "ok", "tenant_id": tenant_id, "report": serialize_report_layout(layout)}


@router.delete("/tenants/{tenant_id}/reports/{report_id}")
async def delete_report_layout_endpoint(
    tenant_id: str,
    report_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    try:
        deleted = delete_report_layout(tenant_id=tenant_id, report_id=report_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Delete report layout failed: {exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Report layout not found")
    return {"status": "ok", "tenant_id": tenant_id, "report_id": report_id, "deleted": True}


@router.get("/tenants/{tenant_id}/report-runs")
async def get_report_runs_endpoint(
    tenant_id: str,
    limit: int = Query(20, ge=1, le=50),
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    try:
        runs = list_recent_report_runs(tenant_id=tenant_id, limit=limit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List report runs failed: {exc}")
    return {
        "tenant_id": tenant_id,
        "count": len(runs),
        "items": [serialize_report_run(item) for item in runs],
    }


@router.post("/tenants/{tenant_id}/report-runs")
async def post_report_run_endpoint(
    tenant_id: str,
    payload: ReportRunCreatePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    _ensure_tenant_active(tenant_id)

    if payload.report_id:
        layout = get_report_layout(tenant_id=tenant_id, report_id=payload.report_id)
        if layout is None:
            raise HTTPException(status_code=404, detail="Report layout not found")
        if str(layout.default_group_id or "").strip() != str(payload.group_id or "").strip():
            raise HTTPException(status_code=400, detail="Selected files must belong to the layout group")

    try:
        resolved = resolve_report_selection(
            tenant_id=tenant_id,
            group_id=payload.group_id,
            file_ids=payload.file_ids,
        )
        normalized_output_format, normalized_csv_delimiter = normalize_report_run_options(
            output_format=payload.output_format,
            csv_delimiter=payload.csv_delimiter,
        )
        files = resolved.get("files") or []
        invalid = [item for item in files if item.get("template_binding_status") != "ready"]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail="Selection contains files without valid template binding",
            )
        required_template_ids = {
            str(item.get("template_id", "")).strip()
            for item in files
            if str(item.get("template_id", "")).strip()
        }
        normalized_columns = parse_report_columns_payload(
            _serialize_report_columns_payload(payload.columns),
            required_template_ids=required_template_ids,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Prepare report run failed: {exc}")

    q = get_queue()
    report_run_id = str(uuid.uuid4())
    job = q.enqueue(
        run_report_flow,
        report_run_id=report_run_id,
        tenant_id=tenant_id,
        group_id=payload.group_id,
        file_ids=[str(item.get("file_id")) for item in files],
        output_format=normalized_output_format,
        csv_delimiter=normalized_csv_delimiter,
        columns=normalized_columns,
        job_timeout=settings.rq_job_timeout_seconds,
    )
    job.meta["tenant_id"] = tenant_id
    job.meta["process_name"] = f"Reporte {payload.group_id}"
    job.meta["report_run_id"] = report_run_id
    job.meta["progress"] = {
        "processed": 0,
        "total": len(files),
        "ok": 0,
        "error": 0,
        "status": "running",
        "message": "Preparando reporte",
    }
    job.save_meta()
    create_report_run(
        report_run_id=report_run_id,
        job_id=job.id,
        report_id=payload.report_id,
        tenant_id=tenant_id,
        group_id=payload.group_id,
        status="running",
        output_format=normalized_output_format,
        csv_delimiter=normalized_csv_delimiter,
        selected_files=files,
        columns_snapshot=normalized_columns,
        detail=serialize_job_status(job),
    )
    return {
        "status": "queued",
        "tenant_id": tenant_id,
        "report_run_id": report_run_id,
        "job_id": job.id,
    }


@router.get("/tenants/{tenant_id}/report-runs/{report_run_id}")
async def get_report_run_endpoint(
    tenant_id: str,
    report_run_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    try:
        record = sync_report_run(tenant_id=tenant_id, report_run_id=report_run_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get report run failed: {exc}")
    if record is None:
        raise HTTPException(status_code=404, detail="Report run not found")
    return serialize_report_run(record)


@router.get("/tenants/{tenant_id}/report-runs/{report_run_id}/download")
async def download_report_run_artifact(
    tenant_id: str,
    report_run_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:read"})),
):
    _ensure_postgres_enabled()
    record = get_report_run(tenant_id=tenant_id, report_run_id=report_run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Report run not found")
    if not record.artifact_path:
        raise HTTPException(status_code=404, detail="Report artifact is not available")
    artifact_path = Path(record.artifact_path)
    if not artifact_path.exists():
        raise HTTPException(status_code=404, detail="Report artifact file is missing")
    return FileResponse(
        path=str(artifact_path),
        filename=record.artifact_filename or artifact_path.name,
        media_type="application/octet-stream",
    )


@router.post("/tenants/{tenant_id}/report-runs/{report_run_id}/reprocess")
async def reprocess_report_run_endpoint(
    tenant_id: str,
    report_run_id: str,
    payload: ReportRunReprocessPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"reports:write"})),
):
    _ensure_postgres_enabled()
    _ensure_tenant_active(tenant_id)
    existing = get_report_run(tenant_id=tenant_id, report_run_id=report_run_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Report run not found")

    files = existing.selected_files or []
    if not files:
        raise HTTPException(status_code=400, detail="Stored run has no selected files")
    output_format = payload.output_format or existing.output_format
    csv_delimiter = payload.csv_delimiter or existing.csv_delimiter
    group_id = existing.group_id
    columns_snapshot = existing.columns_snapshot

    try:
        normalized_output_format, normalized_csv_delimiter = normalize_report_run_options(
            output_format=output_format,
            csv_delimiter=csv_delimiter,
        )
        required_template_ids = {
            str(item.get("template_id", "")).strip()
            for item in files
            if str(item.get("template_id", "")).strip()
        }
        normalized_columns = parse_report_columns_payload(
            columns_snapshot,
            required_template_ids=required_template_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    q = get_queue()
    next_report_run_id = str(uuid.uuid4())
    job = q.enqueue(
        run_report_flow,
        report_run_id=next_report_run_id,
        tenant_id=tenant_id,
        group_id=group_id,
        file_ids=[str(item.get("file_id")) for item in files],
        output_format=normalized_output_format,
        csv_delimiter=normalized_csv_delimiter,
        columns=normalized_columns,
        job_timeout=settings.rq_job_timeout_seconds,
    )
    job.meta["tenant_id"] = tenant_id
    job.meta["process_name"] = f"Reproceso reporte {group_id}"
    job.meta["report_run_id"] = next_report_run_id
    job.meta["progress"] = {
        "processed": 0,
        "total": len(files),
        "ok": 0,
        "error": 0,
        "status": "running",
        "message": "Preparando reporte",
    }
    job.save_meta()
    create_report_run(
        report_run_id=next_report_run_id,
        job_id=job.id,
        report_id=existing.report_id,
        tenant_id=tenant_id,
        group_id=group_id,
        status="running",
        output_format=normalized_output_format,
        csv_delimiter=normalized_csv_delimiter,
        selected_files=files,
        columns_snapshot=normalized_columns,
        detail=serialize_job_status(job),
    )
    return {
        "status": "queued",
        "tenant_id": tenant_id,
        "report_run_id": next_report_run_id,
        "job_id": job.id,
        "source_report_run_id": report_run_id,
    }


@router.post("/jobs/{job_id}/stop")
async def stop_job(
    job_id: str,
    principal: Principal | None = Depends(require_principal(scopes={"jobs:stop"}, require_tenant_match=False)),
):
    try:
        job = Job.fetch(job_id, connection=get_redis())
    except Exception:
        raise HTTPException(status_code=404, detail="Job not found")

    redis_conn = get_redis()
    tenant_id = job.meta.get("tenant_id", "default")
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    enforce_rate_limit(
        bucket="jobs_stop",
        subject=str(tenant_id),
        limit=settings.rate_limit_job_stop_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    lock_key = f"recibox:lock:{tenant_id}"

    try:
        send_stop_job_command(redis_conn, job_id)
    except Exception:
        pass

    try:
        job.cancel()
    except Exception:
        pass

    try:
        redis_conn.delete(lock_key)
    except Exception:
        pass

    process_run = None
    if settings.postgres_url:
        try:
            process_run = mark_process_run_paused(job_id, detail=serialize_job_status(job))
        except Exception:
            process_run = None

    return {
        "status": "stop_requested",
        "job_id": job_id,
        "tenant_id": tenant_id,
        "process_run": serialize_process_run(process_run) if process_run else None,
    }

@router.post("/process/{file_id}")
async def process_file(
    file_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"}, require_tenant_match=False)),
):
    return {"file_id": file_id, "status": "queued"}


@router.get("/auth/google/login")
async def google_oauth_login(
    tenant_id: str = Query("default"),
    popup: bool = Query(False),
):
    raise HTTPException(status_code=410, detail="Deprecated endpoint. Use POST /auth/google/start")


@router.post("/auth/google/start")
async def google_oauth_start(
    request: Request,
    payload: OAuthStartPayload,
    tenant_id: str = Query("default"),
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    enforce_rate_limit(
        bucket="oauth_start",
        subject=(principal.subject if principal is not None else get_request_ip(request)),
        limit=settings.rate_limit_oauth_start_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    try:
        code_verifier = google_oauth.generate_code_verifier()
        state = oauth_state.issue_oauth_state(
            get_redis(),
            tenant_id=tenant_id,
            popup=payload.popup,
            code_verifier=code_verifier,
            opener_origin=_popup_origin_from_request(request),
        )
        auth_url = google_oauth.get_authorization_url(
            state,
            code_verifier=code_verifier,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "tenant_id": tenant_id, "auth_url": auth_url}

def _oauth_popup_callback_html(
    tenant_id: str,
    ok: bool,
    message: str,
    opener_origin: str | None = None,
) -> str:
    payload = {
        "source": "recibox-oauth",
        "ok": ok,
        "tenant_id": tenant_id,
        "message": message,
        "opener_origin": opener_origin,
    }
    payload_json = json.dumps(payload)
    payload_param = quote(payload_json, safe="")
    return f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>RECIBOX OAuth</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {{ font-family: Arial, sans-serif; margin: 24px; }}
      .ok {{ color: #15803d; }}
      .error {{ color: #b91c1c; }}
    </style>
  </head>
  <body>
    <h3 class="{("ok" if ok else "error")}">{("Cuenta conectada correctamente" if ok else "Error al conectar la cuenta")}</h3>
    <p>{message}</p>
    <script src="/auth/google/popup-bridge.js?payload={payload_param}"></script>
  </body>
</html>"""


@router.get("/auth/google/popup-bridge.js")
async def google_oauth_popup_bridge(payload: str = Query("{}")):
    try:
        parsed = json.loads(payload)
        if not isinstance(parsed, dict):
            parsed = {}
    except Exception:
        parsed = {}
    payload_json = json.dumps(parsed)
    js = f"""(function () {{
  const payload = {payload_json};
  try {{
    if (window.opener) {{
      window.opener.postMessage(payload, payload.opener_origin || "*");
    }}
  }} catch (_err) {{}}
  setTimeout(function () {{ window.close(); }}, 120);
}})();"""
    return Response(content=js, media_type="application/javascript")


@router.get("/auth/google/callback")
async def google_oauth_callback(
    code: str | None = Query(None),
    state: str = Query("default"),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
):
    popup = False
    tenant_id = "default"
    opener_origin = None
    try:
        state_data = oauth_state.consume_oauth_state(get_redis(), state)
        tenant_id = state_data["tenant_id"]
        popup = bool(state_data["popup"])
        code_verifier = state_data["code_verifier"]
        opener_origin = state_data.get("opener_origin")
        if error:
            message = unquote_plus(str(error_description or error or "").strip()) or "Google OAuth fue cancelado"
            raise ValueError(message)
        if not code:
            raise ValueError("Google OAuth no devolvio un codigo de autorizacion")
        google_oauth.exchange_code_for_token(
            tenant_id,
            code,
            code_verifier=code_verifier,
        )
        redis_conn = get_redis()
        set_tenant_disabled(redis_conn, tenant_id, False)
    except ValueError as exc:
        if popup:
            return HTMLResponse(
                content=_oauth_popup_callback_html(
                    tenant_id=tenant_id,
                    ok=False,
                    message=str(exc),
                    opener_origin=opener_origin,
                )
            )
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        if popup:
            return HTMLResponse(
                content=_oauth_popup_callback_html(
                    tenant_id=tenant_id,
                    ok=False,
                    message=str(exc),
                    opener_origin=opener_origin,
                )
            )
        raise HTTPException(status_code=500, detail=str(exc))

    if popup:
        return HTMLResponse(
            content=_oauth_popup_callback_html(
                tenant_id=tenant_id,
                ok=True,
                message=f"Tenant '{tenant_id}' vinculado.",
                opener_origin=opener_origin,
            )
        )

    return {"status": "ok", "tenant_id": tenant_id}


@router.get("/auth/google/status")
async def google_oauth_status(
    tenant_id: str = Query("default"),
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    try:
        status = google_oauth.get_token_status(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    redis_conn = get_redis()
    tenant_disabled = is_tenant_disabled(redis_conn, tenant_id)
    return {
        **status,
        "tenant_disabled": tenant_disabled,
        "operable": bool(status.get("has_token") and status.get("valid") and not tenant_disabled),
    }


@router.post("/auth/google/unlink")
async def google_oauth_unlink(
    tenant_id: str = Query("default"),
    clear_drive_config: bool = Query(True),
    clear_lock: bool = Query(True),
    disable_tenant: bool = Query(True),
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    try:
        result = google_oauth.unlink_tenant_oauth(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    redis_conn = get_redis()
    if clear_drive_config:
        result["deleted_drive_config"] = clear_tenant_drive_config(redis_conn, tenant_id)
    else:
        result["deleted_drive_config"] = False

    if clear_lock:
        lock_key = f"recibox:lock:{tenant_id}"
        result["deleted_lock"] = bool(redis_conn.delete(lock_key))
    else:
        result["deleted_lock"] = False

    if disable_tenant:
        set_tenant_disabled(redis_conn, tenant_id, True)
        result["tenant_disabled"] = True
    else:
        result["tenant_disabled"] = False

    has_custom = load_tenant_drive_config(redis_conn, tenant_id) is not None
    result["post_unlink"] = {
        "oauth": google_oauth.get_token_status(tenant_id),
        "has_custom_drive_config": has_custom,
        "tenant_disabled": is_tenant_disabled(redis_conn, tenant_id),
    }

    return result


@router.post("/auth/google/refresh")
async def google_oauth_refresh(
    tenant_id: str = Query("default"),
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    try:
        return google_oauth.refresh_tenant_credentials(tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/tenants/{tenant_id}/service-tokens")
async def get_service_tokens_endpoint(
    tenant_id: str,
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    ensure_principal_has_roles(principal, {"owner", "admin"})
    _ensure_postgres_enabled()
    try:
        tokens = list_service_tokens(tenant_id=tenant_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List service tokens failed: {exc}")
    return {
        "tenant_id": tenant_id,
        "count": len(tokens),
        "items": [
            {
                "token_id": token.token_id,
                "tenant_id": token.tenant_id,
                "name": token.name,
                "scopes": token.scopes,
                "created_by_uid": token.created_by_uid,
                "expires_at": token.expires_at.isoformat() if token.expires_at else None,
                "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None,
                "last_used_at": token.last_used_at.isoformat() if token.last_used_at else None,
                "created_at": token.created_at.isoformat(),
                "updated_at": token.updated_at.isoformat(),
            }
            for token in tokens
        ],
    }


@router.post("/tenants/{tenant_id}/service-tokens")
async def post_service_token_endpoint(
    tenant_id: str,
    payload: ServiceTokenCreatePayload,
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    ensure_principal_has_roles(principal, {"owner", "admin"})
    if principal is None or not principal.uid:
        raise HTTPException(status_code=401, detail="Missing authenticated user")
    _ensure_postgres_enabled()
    enforce_rate_limit(
        bucket="service_tokens",
        subject=principal.subject,
        limit=settings.rate_limit_service_token_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    try:
        token_record, plain_token = create_service_token(
            tenant_id=tenant_id,
            name=payload.name,
            scopes=payload.scopes,
            created_by_uid=principal.uid,
            expires_in_days=payload.expires_in_days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create service token failed: {exc}")
    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "token": {
            "token_id": token_record.token_id,
            "name": token_record.name,
            "scopes": token_record.scopes,
            "created_by_uid": token_record.created_by_uid,
            "expires_at": token_record.expires_at.isoformat() if token_record.expires_at else None,
            "created_at": token_record.created_at.isoformat(),
            "secret": plain_token,
        },
    }


@router.post("/tenants/{tenant_id}/service-tokens/{token_id}/revoke")
async def revoke_service_token_endpoint(
    tenant_id: str,
    token_id: str,
    principal: Principal | None = Depends(require_user_principal()),
):
    if principal is not None:
        ensure_principal_matches_tenant(principal, tenant_id)
    ensure_principal_has_roles(principal, {"owner", "admin"})
    _ensure_postgres_enabled()
    try:
        token_record = revoke_service_token(tenant_id=tenant_id, token_id=token_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Revoke service token failed: {exc}")
    if token_record is None:
        raise HTTPException(status_code=404, detail="Service token not found")
    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "token_id": token_record.token_id,
        "revoked_at": token_record.revoked_at.isoformat() if token_record.revoked_at else None,
    }


@router.get("/tenants/{tenant_id}/drive-config")
async def get_tenant_drive_config(
    tenant_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"drive:read"})),
):
    redis_conn = get_redis()
    cfg = load_tenant_drive_config(redis_conn, tenant_id)
    if not cfg:
        default_input = (settings.drive_input_folder_id or "").strip()
        default_root = (settings.drive_root_folder_id or "").strip()
        if default_input and default_root:
            cfg = {
                "tenant_id": tenant_id,
                "drive_input_folder_id": default_input,
                "drive_root_folder_id": default_root,
                "drive_recibox_folder_id": None,
                "source": "default_env",
                "updated_at": None,
            }
        else:
            cfg = {
                "tenant_id": tenant_id,
                "drive_input_folder_id": None,
                "drive_root_folder_id": None,
                "drive_recibox_folder_id": None,
                "source": "not_configured",
                "updated_at": None,
            }
    else:
        cfg = {
            "tenant_id": cfg.tenant_id,
            "drive_input_folder_id": cfg.drive_input_folder_id,
            "drive_root_folder_id": cfg.drive_root_folder_id,
            "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
            "source": cfg.source,
            "updated_at": cfg.updated_at,
        }
    has_custom = load_tenant_drive_config(redis_conn, tenant_id) is not None
    return {
        "tenant_id": cfg["tenant_id"],
        "drive_input_folder_id": cfg["drive_input_folder_id"],
        "drive_root_folder_id": cfg["drive_root_folder_id"],
        "drive_recibox_folder_id": cfg["drive_recibox_folder_id"],
        "source": cfg["source"],
        "has_custom_config": has_custom,
        "updated_at": cfg["updated_at"],
    }


@router.put("/tenants/{tenant_id}/drive-config")
async def put_tenant_drive_config(
    tenant_id: str,
    payload: TenantDriveConfigPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    redis_conn = get_redis()
    try:
        cfg = save_tenant_drive_config(
            redis_conn,
            tenant_id,
            drive_input_folder_id=payload.drive_input_folder_id,
            drive_root_folder_id=payload.drive_root_folder_id,
            drive_recibox_folder_id=payload.drive_recibox_folder_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Save failed: {exc}")

    set_tenant_disabled(redis_conn, tenant_id, False)
    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "drive_input_folder_id": cfg.drive_input_folder_id,
        "drive_root_folder_id": cfg.drive_root_folder_id,
        "drive_recibox_folder_id": cfg.drive_recibox_folder_id,
        "source": cfg.source,
        "updated_at": cfg.updated_at,
    }


@router.delete("/tenants/{tenant_id}/drive-config")
async def delete_tenant_drive_config(
    tenant_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"drive:write"})),
):
    redis_conn = get_redis()
    deleted = clear_tenant_drive_config(redis_conn, tenant_id)
    return {"status": "ok", "tenant_id": tenant_id, "deleted": deleted}


@router.get("/tenants/{tenant_id}/processing-preferences")
async def get_tenant_processing_preferences(
    tenant_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"})),
):
    redis_conn = get_redis()
    cfg = resolve_tenant_processing_preferences(redis_conn, tenant_id)
    has_custom = load_tenant_processing_preferences(redis_conn, tenant_id) is not None
    return {
        "tenant_id": cfg.tenant_id,
        "filename_format_mode": cfg.filename_format_mode,
        "filename_custom_format": {
            "part1": cfg.filename_custom_format.part1,
            "sep1": cfg.filename_custom_format.sep1,
            "part2": cfg.filename_custom_format.part2,
            "sep2": cfg.filename_custom_format.sep2,
            "part3": cfg.filename_custom_format.part3,
        },
        "employee_folder_number_mode": cfg.employee_folder_number_mode,
        "employee_folder_number_custom_part1": cfg.employee_folder_number_custom_part1,
        "employee_folder_number_custom_part2": cfg.employee_folder_number_custom_part2,
        "auto_create_missing_employee_folder": cfg.auto_create_missing_employee_folder,
        "source": cfg.source,
        "has_custom_config": has_custom,
        "updated_at": cfg.updated_at,
    }


@router.put("/tenants/{tenant_id}/processing-preferences")
async def put_tenant_processing_preferences(
    tenant_id: str,
    payload: ProcessingPreferencesPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"})),
):
    redis_conn = get_redis()
    try:
        cfg = save_tenant_processing_preferences(
            redis_conn,
            tenant_id,
            filename_format_mode=payload.filename_format_mode,
            filename_custom_format=(
                payload.filename_custom_format.model_dump() if payload.filename_custom_format else None
            ),
            employee_folder_number_mode=payload.employee_folder_number_mode,
            employee_folder_number_custom_part1=payload.employee_folder_number_custom_part1,
            employee_folder_number_custom_part2=payload.employee_folder_number_custom_part2,
            auto_create_missing_employee_folder=payload.auto_create_missing_employee_folder,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Save failed: {exc}")

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "filename_format_mode": cfg.filename_format_mode,
        "filename_custom_format": {
            "part1": cfg.filename_custom_format.part1,
            "sep1": cfg.filename_custom_format.sep1,
            "part2": cfg.filename_custom_format.part2,
            "sep2": cfg.filename_custom_format.sep2,
            "part3": cfg.filename_custom_format.part3,
        },
        "employee_folder_number_mode": cfg.employee_folder_number_mode,
        "employee_folder_number_custom_part1": cfg.employee_folder_number_custom_part1,
        "employee_folder_number_custom_part2": cfg.employee_folder_number_custom_part2,
        "auto_create_missing_employee_folder": cfg.auto_create_missing_employee_folder,
        "source": cfg.source,
        "updated_at": cfg.updated_at,
    }


@router.delete("/tenants/{tenant_id}/processing-preferences")
async def delete_tenant_processing_preferences(
    tenant_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"jobs:run"})),
):
    redis_conn = get_redis()
    deleted = clear_tenant_processing_preferences(redis_conn, tenant_id)
    return {"status": "ok", "tenant_id": tenant_id, "deleted": deleted}


@router.post("/tenants/{tenant_id}/templates/draft-from-file")
async def create_template_draft_from_file(
    tenant_id: str,
    payload: TemplateDraftFromFilePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        draft = build_template_draft_for_file(
            payload.file_id.strip(),
            tenant_id=tenant_id,
            file_name=payload.file_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Draft failed: {exc}")

    return {
        "tenant_id": tenant_id,
        "file_id": draft["file_id"],
        "file_name": draft["file_name"],
        "original_model": draft["original_model"],
        "custom_model": draft["custom_model"],
    }


@router.get("/tenants/{tenant_id}/template-groups")
async def get_template_groups_endpoint(
    tenant_id: str,
    sync: bool = Query(False),
    _principal: Principal | None = Depends(require_principal(scopes={"templates:read"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        groups = list_template_groups(tenant_id=tenant_id)
        if sync:
            groups = [_sync_template_group_drive_folder_if_needed(group) for group in groups]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List groups failed: {exc}")

    return {
        "tenant_id": tenant_id,
        "count": len(groups),
        "groups": [_serialize_template_group(group) for group in groups],
    }


@router.post("/tenants/{tenant_id}/template-groups")
async def post_template_group(
    tenant_id: str,
    payload: TemplateGroupPayload,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        ensure_template_group_name_available(
            tenant_id=tenant_id,
            name=payload.name,
        )
        drive_folder = ensure_template_group_drive_folder(
            tenant_id=tenant_id,
            group_name=payload.name,
        )
        drive_folder_id = str(drive_folder.get("id", "")).strip()
        if not drive_folder_id:
            raise RuntimeError("Drive group folder id is empty")
        group = create_template_group(
            tenant_id=tenant_id,
            name=payload.name,
            drive_folder_id=drive_folder_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create group failed: {exc}")

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "group": _serialize_template_group(group),
    }


@router.get("/tenants/{tenant_id}/templates")
async def get_templates(
    tenant_id: str,
    include_inactive: bool = Query(True),
    _principal: Principal | None = Depends(require_principal(scopes={"templates:read"})),
):
    try:
        templates = list_document_templates(tenant_id=tenant_id, include_inactive=include_inactive)
        rules_by_template = list_classification_rules_for_templates(
            tenant_id=tenant_id,
            template_ids=[template.template_id for template in templates],
        )
        groups_by_id = get_template_groups_map(
            tenant_id=tenant_id,
            group_ids=[str(template.group_id or "").strip() for template in templates if str(template.group_id or "").strip()],
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"List failed: {exc}")

    serialized_templates: list[dict] = []
    for template in templates:
        rule = rules_by_template.get(template.template_id)
        rule_status, has_rule, _ = _resolve_template_rule_metadata(template, rule)
        group = groups_by_id.get(str(template.group_id or "").strip())
        if group:
            template.drive_folder_id = group.drive_folder_id
        serialized_templates.append(
            _serialize_template_summary_payload(
                template=template,
                group_name=group.name if group else None,
                rule_status=rule_status,
                has_rule=has_rule,
            )
        )

    return {
        "tenant_id": tenant_id,
        "count": len(templates),
        "templates": serialized_templates,
    }


@router.get("/tenants/{tenant_id}/templates/{template_id}")
async def get_template_detail(
    tenant_id: str,
    template_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:read"})),
):
    try:
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
        rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
        group_id = str(template.group_id or "").strip() if template else ""
        group = get_template_group(tenant_id=tenant_id, group_id=group_id) if group_id else None
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get failed: {exc}")
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    if group:
        template.drive_folder_id = group.drive_folder_id
    rule_status, has_rule, rule_errors = _resolve_template_rule_metadata(template, rule)
    serialized_rule = serialize_classification_rule(rule)
    if serialized_rule:
        serialized_rule["rule_status"] = rule_status

    return _serialize_template_detail_payload(
        template=template,
        group_name=group.name if group else None,
        rule_status=rule_status,
        has_rule=has_rule,
        rule_errors=rule_errors,
        serialized_rule=serialized_rule,
    )


@router.get("/tenants/{tenant_id}/templates/{template_id}/source-pdf")
async def get_template_source_pdf(
    tenant_id: str,
    template_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:read"})),
):
    _ensure_tenant_active(tenant_id)
    try:
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get template failed: {exc}")
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    try:
        source_path = resolve_template_source_pdf(
            tenant_id=tenant_id,
            template_id=template_id,
            sample_file_metadata=template.sample_file_metadata,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Source PDF read failed: {exc}")

    if not source_path:
        raise HTTPException(status_code=404, detail="Template source PDF not found")

    file_name = f"{template_id}.pdf"
    metadata = template.sample_file_metadata or {}
    candidate_name = metadata.get("file_name")
    if isinstance(candidate_name, str) and candidate_name.strip():
        file_name = candidate_name.strip()

    return FileResponse(path=str(source_path), media_type="application/pdf", filename=file_name)


@router.post("/tenants/{tenant_id}/templates/{template_id}/source-pdf")
async def post_template_source_pdf(
    request: Request,
    tenant_id: str,
    template_id: str,
    file: UploadFile = File(...),
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    _ensure_tenant_active(tenant_id)
    enforce_rate_limit(
        bucket="template_upload",
        subject=str(tenant_id),
        limit=settings.rate_limit_upload_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    try:
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get template failed: {exc}")
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    content_type = (file.content_type or "").strip().lower()
    if content_type and content_type not in {"application/pdf", "application/x-pdf"}:
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    try:
        max_bytes = max(int(settings.max_template_source_pdf_mb), 1) * 1024 * 1024
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Template source PDF exceeds {settings.max_template_source_pdf_mb} MB limit",
                )
            chunks.append(chunk)
        content = b"".join(chunks)
        save_template_source_pdf(tenant_id=tenant_id, template_id=template_id, content=content)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Source PDF save failed: {exc}")
    finally:
        await file.close()

    return {"status": "ok", "tenant_id": tenant_id, "template_id": template_id, "stored": True}


@router.post("/tenants/{tenant_id}/templates")
async def post_template(
    tenant_id: str,
    payload: TemplatePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    try:
        group = get_template_group(tenant_id=tenant_id, group_id=payload.group_id)
        if not group:
            raise HTTPException(status_code=400, detail="Template group not found")
        template = create_document_template(
            tenant_id=tenant_id,
            name=payload.name,
            group_id=payload.group_id,
            description=payload.description,
            is_active=payload.is_active,
            original_model=payload.original_model,
            custom_model=payload.custom_model,
            sample_file_metadata=payload.sample_file_metadata,
            field_transforms=payload.field_transforms,
        )
        group_name = group.name
        drive_folder_id = group.drive_folder_id
        template.drive_folder_id = drive_folder_id
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Create failed: {exc}")

    rule_status, has_rule, _ = _resolve_template_rule_metadata(template, None)
    payload = _serialize_template_detail_payload(
        template=template,
        group_name=group_name,
        rule_status=rule_status,
        has_rule=has_rule,
        rule_errors=[],
        serialized_rule=None,
    )
    payload.update({
        "status": "ok",
    })
    return payload


@router.put("/tenants/{tenant_id}/templates/{template_id}")
async def put_template(
    tenant_id: str,
    template_id: str,
    payload: TemplatePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    try:
        existing_template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get template failed: {exc}")
    if not existing_template:
        raise HTTPException(status_code=404, detail="Template not found")

    try:
        group = get_template_group(tenant_id=tenant_id, group_id=payload.group_id)
        if not group:
            raise HTTPException(status_code=400, detail="Template group not found")
        template = update_document_template(
            tenant_id=tenant_id,
            template_id=template_id,
            name=payload.name,
            group_id=payload.group_id,
            description=payload.description,
            is_active=payload.is_active,
            original_model=payload.original_model,
            custom_model=payload.custom_model,
            sample_file_metadata=payload.sample_file_metadata,
            field_transforms=payload.field_transforms,
        )
        group_name = group.name
        drive_folder_id = group.drive_folder_id
        if template is not None:
            template.drive_folder_id = drive_folder_id
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Update failed: {exc}")

    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
    rule_status, has_rule, rule_errors = _resolve_template_rule_metadata(template, rule)
    serialized_rule = serialize_classification_rule(rule)
    if serialized_rule:
        serialized_rule["rule_status"] = rule_status

    response_payload = _serialize_template_detail_payload(
        template=template,
        group_name=group_name,
        rule_status=rule_status,
        has_rule=has_rule,
        rule_errors=rule_errors,
        serialized_rule=serialized_rule,
    )
    response_payload.update({
        "status": "ok",
    })
    return response_payload


@router.get("/tenants/{tenant_id}/templates/{template_id}/classification-rule")
async def get_template_classification_rule(
    tenant_id: str,
    template_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:read"})),
):
    try:
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get template failed: {exc}")
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    if resolve_template_mode(template.custom_model) != "document":
        raise HTTPException(status_code=400, detail="Template is not compatible with document mode")

    try:
        rule = get_classification_rule(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get classification rule failed: {exc}")

    rule_status, has_rule, rule_errors = _resolve_template_rule_metadata(template, rule)
    serialized_rule = serialize_classification_rule(rule)
    if serialized_rule:
        serialized_rule["rule_status"] = rule_status

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "template_id": template_id,
        "rule_status": rule_status,
        "has_rule": has_rule,
        "rule_errors": rule_errors,
        "classification_rule": serialized_rule,
    }


@router.put("/tenants/{tenant_id}/templates/{template_id}/classification-rule")
async def put_template_classification_rule(
    tenant_id: str,
    template_id: str,
    payload: ClassificationRulePayload,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    try:
        template = get_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Get template failed: {exc}")
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    if resolve_template_mode(template.custom_model) != "document":
        raise HTTPException(status_code=400, detail="Template is not compatible with document mode")

    try:
        parsed_rule = parse_classification_rule_payload(payload.model_dump())
        field_definitions = extract_document_field_definitions(template.custom_model)
        validation_errors = validate_classification_rule_against_fields(parsed_rule, field_definitions)
        if validation_errors:
            raise HTTPException(status_code=400, detail="; ".join(validation_errors))

        saved_rule = upsert_classification_rule(
            tenant_id=tenant_id,
            template_id=template_id,
            rule=parsed_rule,
            rule_status="ready",
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Save classification rule failed: {exc}")

    rule_status, has_rule, rule_errors = _resolve_template_rule_metadata(template, saved_rule)
    serialized_rule = serialize_classification_rule(saved_rule)
    if serialized_rule:
        serialized_rule["rule_status"] = rule_status

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "template_id": template_id,
        "rule_status": rule_status,
        "has_rule": has_rule,
        "rule_errors": rule_errors,
        "classification_rule": serialized_rule,
    }


@router.delete("/tenants/{tenant_id}/templates/{template_id}")
async def remove_template(
    tenant_id: str,
    template_id: str,
    _principal: Principal | None = Depends(require_principal(scopes={"templates:write"})),
):
    try:
        deleted = delete_document_template(tenant_id=tenant_id, template_id=template_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Delete failed: {exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found")
    delete_template_source_pdf(tenant_id=tenant_id, template_id=template_id)
    return {"status": "ok", "tenant_id": tenant_id, "template_id": template_id, "deleted": True}
