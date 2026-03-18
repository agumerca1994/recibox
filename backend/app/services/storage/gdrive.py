from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Optional

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
from google.oauth2.service_account import Credentials

from app.services.auth import google_oauth

from app.core.config import settings


def _scopes() -> list[str]:
    raw = settings.google_oauth_scopes.strip()
    if not raw:
        return []
    return [s for s in re.split(r"[\s,]+", raw) if s]


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


def list_files_in_folder(
    folder_id: str,
    *,
    tenant_id: str | None = None,
    query_extra: str | None = None,
    page_size: Optional[int] = None,
    fields: str = "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, parents)",
) -> Iterable[dict]:
    service = _get_service(tenant_id=tenant_id)
    q = f"'{folder_id}' in parents and trashed = false"
    if query_extra:
        q = f"{q} and {query_extra}"

    page_token = None
    while True:
        try:
            resp = (
                service.files()
                .list(
                    q=q,
                    pageSize=page_size or settings.drive_page_size,
                    fields=fields,
                    pageToken=page_token,
                    supportsAllDrives=settings.drive_supports_all_drives,
                    includeItemsFromAllDrives=settings.drive_include_items_from_all_drives,
                )
                .execute()
            )
        except HttpError as exc:
            raise RuntimeError(f"Drive list failed: {exc}") from exc

        for f in resp.get("files", []):
            yield f

        page_token = resp.get("nextPageToken")
        if not page_token:
            break


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
) -> dict:
    service = _get_service(tenant_id=tenant_id)
    body = {}
    if new_name:
        body["name"] = new_name

    try:
        return (
            service.files()
            .update(
                fileId=file_id,
                body=body,
                addParents=add_parents,
                removeParents=remove_parents,
                fields="id, name, parents",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
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


def move_and_rename(file_id: str, folder_id: str, new_name: str, *, tenant_id: str | None = None) -> dict:
    current_parents = ",".join(get_file_parents(file_id, tenant_id=tenant_id))
    return update_file_metadata(
        file_id,
        new_name=new_name,
        add_parents=folder_id,
        remove_parents=current_parents or None,
        tenant_id=tenant_id,
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
        return (
            service.files()
            .create(
                body=metadata,
                fields="id, name, parents",
                supportsAllDrives=settings.drive_supports_all_drives,
            )
            .execute()
        )
    except HttpError as exc:
        raise RuntimeError(f"Drive create folder failed: {exc}") from exc


def delete_file(file_id: str, *, tenant_id: str | None = None) -> None:
    service = _get_service(tenant_id=tenant_id)
    try:
        service.files().delete(
            fileId=file_id,
            supportsAllDrives=settings.drive_supports_all_drives,
        ).execute()
    except HttpError as exc:
        raise RuntimeError(f"Drive delete failed: {exc}") from exc


def ensure_folder(parent_id: str, name: str, *, tenant_id: str | None = None) -> dict:
    existing = find_folder_by_name(parent_id, name, tenant_id=tenant_id)
    if existing:
        return existing
    return create_folder(parent_id, name, tenant_id=tenant_id)
