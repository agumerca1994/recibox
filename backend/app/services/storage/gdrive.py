from __future__ import annotations

from pathlib import Path
from threading import RLock
import time
from typing import Iterable, Optional

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
from google.oauth2.service_account import Credentials

from app.services.auth import google_oauth

from app.core.config import settings


_FOLDER_LIST_CACHE_TTL_SECONDS = 20.0
_DRIVE_ID_CACHE_TTL_SECONDS = 300.0
_folder_list_cache: dict[tuple[str, str, str, int, str], tuple[float, list[dict]]] = {}
_folder_drive_id_cache: dict[tuple[str, str], tuple[float, str | None]] = {}
_cache_lock = RLock()


def _tenant_cache_key(tenant_id: str | None) -> str:
    return str(tenant_id or "").strip().lower()


def _get_cached_folder_listing(
    cache_key: tuple[str, str, str, int, str],
) -> list[dict] | None:
    now = time.monotonic()
    with _cache_lock:
        cached = _folder_list_cache.get(cache_key)
        if not cached:
            return None
        cached_at, items = cached
        if now - cached_at > _FOLDER_LIST_CACHE_TTL_SECONDS:
            _folder_list_cache.pop(cache_key, None)
            return None
        return [dict(item) for item in items]


def _set_cached_folder_listing(
    cache_key: tuple[str, str, str, int, str],
    items: list[dict],
) -> None:
    with _cache_lock:
        _folder_list_cache[cache_key] = (time.monotonic(), [dict(item) for item in items])


def _invalidate_folder_listing_cache(folder_id: str, *, tenant_id: str | None = None) -> None:
    normalized_folder = str(folder_id or "").strip()
    if not normalized_folder:
        return
    normalized_tenant = _tenant_cache_key(tenant_id)
    with _cache_lock:
        keys_to_delete = [
            key
            for key in _folder_list_cache.keys()
            if key[0] == normalized_tenant and key[1] == normalized_folder
        ]
        for key in keys_to_delete:
            _folder_list_cache.pop(key, None)


def _invalidate_parent_cache_list(parent_ids: str | None, *, tenant_id: str | None = None) -> None:
    if not parent_ids:
        return
    for parent_id in str(parent_ids).split(","):
        normalized_parent = parent_id.strip()
        if normalized_parent:
            _invalidate_folder_listing_cache(normalized_parent, tenant_id=tenant_id)


def _get_folder_drive_id(folder_id: str, *, tenant_id: str | None = None) -> str | None:
    if folder_id == "root":
        return None
    cache_key = (_tenant_cache_key(tenant_id), str(folder_id))
    now = time.monotonic()
    with _cache_lock:
        cached = _folder_drive_id_cache.get(cache_key)
        if cached:
            cached_at, drive_id = cached
            if now - cached_at <= _DRIVE_ID_CACHE_TTL_SECONDS:
                return drive_id
            _folder_drive_id_cache.pop(cache_key, None)

    try:
        folder_meta = get_file_metadata(folder_id, tenant_id=tenant_id, fields="id, driveId")
    except Exception:
        folder_meta = None
    drive_id = (folder_meta or {}).get("driveId")
    with _cache_lock:
        _folder_drive_id_cache[cache_key] = (now, drive_id)
    return drive_id


def _scopes() -> list[str]:
    return [s.strip() for s in settings.google_oauth_scopes.split(",") if s.strip()]


def _get_service(*, tenant_id: str | None = None):
    creds = None
    if tenant_id:
        try:
            creds = google_oauth.ensure_fresh_credentials(tenant_id)
        except Exception:
            if settings.oauth_required_for_tenant:
                raise
            creds = None

    if not creds:
        service_account_path = (settings.google_application_credentials or "").strip()
        if not service_account_path:
            raise RuntimeError(
                "No OAuth token configured for tenant and GOOGLE_APPLICATION_CREDENTIALS is empty"
            )
        creds = Credentials.from_service_account_file(
            service_account_path,
            scopes=_scopes(),
        )
        if settings.google_subject:
            creds = creds.with_subject(settings.google_subject)
    return build("drive", "v3", credentials=creds)


def get_file_metadata(
    file_id: str,
    *,
    tenant_id: str | None = None,
    fields: str = "id, name, mimeType, parents, driveId, appProperties, createdTime, modifiedTime, webViewLink",
) -> dict:
    service = _get_service(tenant_id=tenant_id)
    try:
        return (
            service.files()
            .get(
                fileId=file_id,
                fields=fields,
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
    except HttpError as exc:
        raise RuntimeError(f"Drive get metadata failed: {exc}") from exc


def list_files_in_folder(
    folder_id: str,
    *,
    tenant_id: str | None = None,
    query_extra: str | None = None,
    page_size: Optional[int] = None,
    fields: str = "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, parents, webViewLink, appProperties)",
) -> Iterable[dict]:
    normalized_folder_id = str(folder_id or "").strip()
    normalized_query_extra = str(query_extra or "").strip()
    normalized_page_size = int(page_size or settings.drive_page_size)
    cache_key = (
        _tenant_cache_key(tenant_id),
        normalized_folder_id,
        normalized_query_extra,
        normalized_page_size,
        fields,
    )
    cached_items = _get_cached_folder_listing(cache_key)
    if cached_items is not None:
        for item in cached_items:
            yield item
        return

    service = _get_service(tenant_id=tenant_id)
    q = f"'{folder_id}' in parents and trashed = false"
    if query_extra:
        q = f"{q} and {query_extra}"

    drive_id = _get_folder_drive_id(folder_id, tenant_id=tenant_id)

    page_token = None
    collected_items: list[dict] = []
    while True:
        try:
            request_kwargs = {
                "q": q,
                "pageSize": normalized_page_size,
                "fields": fields,
                "pageToken": page_token,
                "supportsAllDrives": settings.drive_supports_all_drives,
                "includeItemsFromAllDrives": settings.drive_include_items_from_all_drives,
            }
            if drive_id:
                request_kwargs["corpora"] = "drive"
                request_kwargs["driveId"] = drive_id
            elif settings.drive_include_items_from_all_drives:
                request_kwargs["corpora"] = "allDrives"

            resp = service.files().list(**request_kwargs).execute()
        except HttpError as exc:
            raise RuntimeError(f"Drive list failed: {exc}") from exc

        for f in resp.get("files", []):
            collected_items.append(dict(f))
            yield f

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    _set_cached_folder_listing(cache_key, collected_items)


def list_new_files(*, tenant_id: str | None = None, input_folder_id: str | None = None) -> Iterable[dict]:
    folder_id = (input_folder_id or settings.drive_input_folder_id or "").strip()
    if not folder_id:
        raise RuntimeError("Drive input folder id is not configured")
    return list_files_in_folder(
        folder_id,
        query_extra="mimeType = 'application/pdf'",
        tenant_id=tenant_id,
    )


def download_file(file_id: str, dest_path: str, *, tenant_id: str | None = None) -> Path:
    service = _get_service(tenant_id=tenant_id)
    dest = Path(dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)

    try:
        request = service.files().get_media(
            fileId=file_id,
            supportsAllDrives=settings.drive_supports_all_drives,
        )
        with dest.open("wb") as fh:
            downloader = MediaIoBaseDownload(fh, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
    except HttpError as exc:
        raise RuntimeError(f"Drive download failed: {exc}") from exc

    return dest


def upload_file(
    local_path: str,
    *,
    parent_id: str,
    tenant_id: str | None = None,
    name: str | None = None,
    mime_type: str = "application/pdf",
) -> dict:
    service = _get_service(tenant_id=tenant_id)
    metadata = {"name": name or Path(local_path).name, "parents": [parent_id]}
    media = MediaFileUpload(local_path, mimetype=mime_type, resumable=True)

    try:
        return (
            service.files()
            .create(
                body=metadata,
                media_body=media,
                fields="id, name, mimeType, parents",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
    except HttpError as exc:
        raise RuntimeError(f"Drive upload failed: {exc}") from exc


def update_file_metadata(
    file_id: str,
    *,
    tenant_id: str | None = None,
    new_name: str | None = None,
    add_parents: str | None = None,
    remove_parents: str | None = None,
    app_properties: dict[str, str | None] | None = None,
) -> dict:
    service = _get_service(tenant_id=tenant_id)
    body = {}
    if new_name:
        body["name"] = new_name
    if app_properties is not None:
        try:
            current = get_file_metadata(file_id, tenant_id=tenant_id, fields="appProperties")
            merged = dict(current.get("appProperties") or {})
        except Exception:
            merged = {}
        for key, value in app_properties.items():
            normalized_key = str(key or "").strip()
            if not normalized_key:
                continue
            normalized_value = str(value or "").strip() if value is not None else ""
            if normalized_value:
                merged[normalized_key] = normalized_value
            else:
                merged.pop(normalized_key, None)
        if merged:
            body["appProperties"] = merged
        elif app_properties:
            body["appProperties"] = {}

    try:
        response = (
            service.files()
            .update(
                fileId=file_id,
                body=body,
                addParents=add_parents,
                removeParents=remove_parents,
                fields="id, name, mimeType, parents, appProperties, createdTime, modifiedTime, webViewLink",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
        _invalidate_parent_cache_list(add_parents, tenant_id=tenant_id)
        _invalidate_parent_cache_list(remove_parents, tenant_id=tenant_id)
        return response
    except HttpError as exc:
        raise RuntimeError(f"Drive update failed: {exc}") from exc


def get_file_parents(file_id: str, *, tenant_id: str | None = None) -> list[str]:
    service = _get_service(tenant_id=tenant_id)
    try:
        resp = (
            service.files()
            .get(
                fileId=file_id,
                fields="parents",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
    except HttpError as exc:
        raise RuntimeError(f"Drive get parents failed: {exc}") from exc
    return resp.get("parents", [])


def move_and_rename(
    file_id: str,
    folder_id: str,
    new_name: str,
    *,
    tenant_id: str | None = None,
    app_properties: dict[str, str | None] | None = None,
) -> dict:
    current_parents = ",".join(get_file_parents(file_id, tenant_id=tenant_id))
    return update_file_metadata(
        file_id,
        new_name=new_name,
        add_parents=folder_id,
        remove_parents=current_parents or None,
        tenant_id=tenant_id,
        app_properties=app_properties,
    )


def find_folder_by_name(parent_id: str, name: str, *, tenant_id: str | None = None) -> Optional[dict]:
    query = (
        "mimeType = 'application/vnd.google-apps.folder' "
        f"and name = '{name}'"
    )
    for f in list_files_in_folder(parent_id, query_extra=query, tenant_id=tenant_id):
        return f
    return None


def create_folder(parent_id: str, name: str, *, tenant_id: str | None = None) -> dict:
    service = _get_service(tenant_id=tenant_id)
    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    try:
        response = (
            service.files()
            .create(
                body=metadata,
                fields="id, name, parents",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
        _invalidate_folder_listing_cache(parent_id, tenant_id=tenant_id)
        return response
    except HttpError as exc:
        raise RuntimeError(f"Drive create folder failed: {exc}") from exc


def delete_file(file_id: str, *, tenant_id: str | None = None) -> None:
    parent_ids = []
    try:
        parent_ids = get_file_parents(file_id, tenant_id=tenant_id)
    except Exception:
        parent_ids = []
    service = _get_service(tenant_id=tenant_id)
    try:
        service.files().delete(
            fileId=file_id,
            supportsAllDrives=settings.drive_supports_all_drives,
        ).execute()
        _invalidate_parent_cache_list(",".join(parent_ids), tenant_id=tenant_id)
    except HttpError as exc:
        raise RuntimeError(f"Drive delete failed: {exc}") from exc


def ensure_folder(parent_id: str, name: str, *, tenant_id: str | None = None) -> dict:
    existing = find_folder_by_name(parent_id, name, tenant_id=tenant_id)
    if existing:
        return existing
    return create_folder(parent_id, name, tenant_id=tenant_id)
