from __future__ import annotations

import json
import re
from pathlib import Path
from secrets import choice
from typing import Iterable
from urllib import parse, request

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from app.core.config import settings


_PKCE_VERIFIER_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"


def _scopes() -> list[str]:
    return [s.strip() for s in settings.google_oauth_scopes.replace(",", " ").split() if s.strip()]


def _scope_set(scopes: Iterable[str] | str | None) -> set[str]:
    if isinstance(scopes, str):
        values = scopes.replace(",", " ").split()
    else:
        values = scopes or []
    return {scope.strip() for scope in values if scope and scope.strip()}


def _stored_scope_set(tenant_id: str) -> set[str]:
    path = _token_path(tenant_id)
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    return _scope_set(payload.get("scopes"))


def _missing_scopes(tenant_id: str, creds: Credentials) -> list[str]:
    required = _scope_set(_scopes())
    granted = (
        _stored_scope_set(tenant_id)
        or _scope_set(getattr(creds, "granted_scopes", None))
        or _scope_set(creds.scopes)
    )
    return sorted(required - granted)


def _granted_scopes(tenant_id: str, creds: Credentials) -> list[str]:
    return sorted(
        _stored_scope_set(tenant_id)
        or _scope_set(getattr(creds, "granted_scopes", None))
        or _scope_set(creds.scopes)
    )


def _has_required_scopes(tenant_id: str, creds: Credentials) -> bool:
    return not _missing_scopes(tenant_id, creds)


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


def _refresh_error_message(exc: Exception) -> str:
    raw = str(exc or "").strip()
    if raw:
        return raw
    return exc.__class__.__name__


def _is_reauth_required_error(exc: Exception) -> bool:
    message = _refresh_error_message(exc).lower()
    return any(
        marker in message
        for marker in (
            "invalid_grant",
            "expired or revoked",
            "token has been expired or revoked",
            "invalid_rapt",
            "reauth",
        )
    )


def _describe_reauth_required() -> str:
    return "La autorizacion de Google Drive vencio o fue revocada. Volve a conectar la cuenta."


def ensure_fresh_credentials(tenant_id: str) -> Credentials:
    creds = load_credentials(tenant_id)
    if not creds:
        raise RuntimeError(f"No OAuth token configured for tenant '{tenant_id}'")

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            save_credentials(tenant_id, creds)
        except Exception as exc:
            if _is_reauth_required_error(exc):
                raise RuntimeError(_describe_reauth_required()) from exc
            raise RuntimeError(_refresh_error_message(exc)) from exc
    elif creds.expired and not creds.refresh_token:
        raise RuntimeError(_describe_reauth_required())
    if not creds.valid:
        raise RuntimeError(_describe_reauth_required())
    if not _has_required_scopes(tenant_id, creds):
        raise RuntimeError(
            f"Tenant '{tenant_id}' token is missing required OAuth scopes. Re-link Google OAuth to continue."
        )
    return creds


def generate_code_verifier(length: int = 96) -> str:
    # RFC 7636 allows 43..128 characters from the unreserved URI charset.
    if length < 43 or length > 128:
        raise ValueError("PKCE code verifier length must be between 43 and 128")
    return "".join(choice(_PKCE_VERIFIER_CHARS) for _ in range(length))


def build_flow(
    redirect_uri: str | None = None,
    code_verifier: str | None = None,
) -> Flow:
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
        code_verifier=code_verifier,
    )


def get_authorization_url(state: str, code_verifier: str | None = None) -> str:
    flow = build_flow(code_verifier=code_verifier)
    auth_url, _state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
        state=state,
    )
    return auth_url


def exchange_code_for_token(
    tenant_id: str,
    code: str,
    code_verifier: str | None = None,
) -> Credentials:
    flow = build_flow(code_verifier=code_verifier)
    flow.fetch_token(code=code)
    creds = flow.credentials
    save_credentials(tenant_id, creds)
    return creds


def get_token_status(tenant_id: str) -> dict:
    creds = load_credentials(tenant_id)
    if not creds:
        return {
            "tenant_id": tenant_id,
            "has_token": False,
            "valid": False,
            "expired": None,
            "has_refresh_token": False,
            "expiry": None,
            "reauth_required": False,
            "refresh_error": None,
            "status_reason": "not_connected",
        }

    refresh_error = None
    reauth_required = False
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            save_credentials(tenant_id, creds)
        except Exception as exc:
            refresh_error = _refresh_error_message(exc)
            reauth_required = _is_reauth_required_error(exc)
    elif creds.expired and not creds.refresh_token:
        reauth_required = True
        refresh_error = "La cuenta de Google no tiene refresh token. Volve a conectar la cuenta."

    missing_scopes = _missing_scopes(tenant_id, creds)

    return {
        "tenant_id": tenant_id,
        "has_token": True,
        "valid": bool(creds.valid and not missing_scopes and not reauth_required),
        "expired": bool(creds.expired),
        "has_refresh_token": bool(creds.refresh_token),
        "expiry": creds.expiry.isoformat() if creds.expiry else None,
        "granted_scopes": _granted_scopes(tenant_id, creds),
        "missing_scopes": missing_scopes,
        "scope_mismatch": bool(missing_scopes),
        "reauth_required": reauth_required,
        "refresh_error": _describe_reauth_required() if reauth_required else refresh_error,
        "status_reason": (
            "reauth_required"
            if reauth_required
            else "scope_mismatch"
            if missing_scopes
            else "ok"
            if creds.valid
            else "invalid_token"
        ),
    }


def unlink_tenant_oauth(tenant_id: str) -> dict:
    creds = load_credentials(tenant_id)
    path = _token_path(tenant_id)
    revoked = False

    revocation_token = None
    if creds:
        # Prefer refresh token for full grant revocation when available.
        revocation_token = creds.refresh_token or creds.token

    if revocation_token:
        payload = parse.urlencode({"token": revocation_token}).encode("utf-8")
        req = request.Request("https://oauth2.googleapis.com/revoke", data=payload, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with request.urlopen(req, timeout=10):
                revoked = True
        except Exception:
            revoked = False

    deleted = False
    if path.exists():
        path.unlink(missing_ok=True)
        deleted = True

    return {"tenant_id": tenant_id, "revoked": revoked, "deleted_local_token": deleted}


def refresh_tenant_credentials(tenant_id: str) -> dict:
    creds = load_credentials(tenant_id)
    if not creds:
        raise RuntimeError(f"No OAuth token configured for tenant '{tenant_id}'")
    if not creds.refresh_token:
        raise RuntimeError(f"Tenant '{tenant_id}' token has no refresh_token")

    try:
        creds.refresh(Request())
    except Exception as exc:
        if _is_reauth_required_error(exc):
            raise RuntimeError(_describe_reauth_required()) from exc
        raise RuntimeError(_refresh_error_message(exc)) from exc
    save_credentials(tenant_id, creds)
    return {
        "tenant_id": tenant_id,
        "status": "refreshed",
        "expiry": creds.expiry.isoformat() if creds.expiry else None,
    }
