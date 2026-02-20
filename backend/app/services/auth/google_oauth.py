from __future__ import annotations

from pathlib import Path
from typing import Iterable

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app.core.config import settings


def _scopes() -> list[str]:
    return [s.strip() for s in settings.google_oauth_scopes.split(",") if s.strip()]


def _token_path(tenant_id: str) -> Path:
    base = Path(settings.google_oauth_token_dir)
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{tenant_id}.json"


def load_credentials(tenant_id: str) -> Credentials | None:
    path = _token_path(tenant_id)
    if not path.exists():
        return None
    return Credentials.from_authorized_user_file(str(path), scopes=_scopes())


def save_credentials(tenant_id: str, creds: Credentials) -> None:
    path = _token_path(tenant_id)
    path.write_text(creds.to_json(), encoding="utf-8")


def ensure_fresh_credentials(tenant_id: str) -> Credentials:
    creds = load_credentials(tenant_id)
    if not creds:
        raise RuntimeError(f"No OAuth token configured for tenant '{tenant_id}'")

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_credentials(tenant_id, creds)
    return creds


def build_flow(redirect_uri: str | None = None) -> Flow:
    client_secrets = settings.google_oauth_client_secrets
    if not client_secrets:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_SECRETS is not configured")
    target_redirect = redirect_uri or settings.google_oauth_redirect_uri
    if not target_redirect:
        raise RuntimeError("GOOGLE_OAUTH_REDIRECT_URI is not configured")
    return Flow.from_client_secrets_file(
        client_secrets,
        scopes=_scopes(),
        redirect_uri=target_redirect,
    )


def get_authorization_url(tenant_id: str) -> str:
    flow = build_flow()
    auth_url, _state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
        state=tenant_id,
    )
    return auth_url


def exchange_code_for_token(tenant_id: str, code: str) -> Credentials:
    flow = build_flow()
    flow.fetch_token(code=code)
    creds = flow.credentials
    save_credentials(tenant_id, creds)
    return creds
