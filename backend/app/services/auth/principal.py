from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from fastapi import Header, HTTPException, Request

from app.core.config import settings
from app.services.auth import firebase_auth
from app.services.auth.rate_limit import enforce_rate_limit, get_request_ip
from app.services.auth.service_tokens import ServiceTokenRecord, verify_service_token
from app.services.tenants.user_tenants import resolve_or_create_user_tenant


@dataclass
class Principal:
    kind: str
    subject: str
    tenant_id: str
    uid: str | None = None
    email: str | None = None
    scopes: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()
    service_token_id: str | None = None
    service_name: str | None = None


def _normalize_tenant_id(value: str | None) -> str:
    tenant_id = str(value or "").strip().lower()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required")
    return tenant_id


def _extract_bearer_token(authorization: str | None) -> str:
    raw = str(authorization or "").strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    parts = raw.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(status_code=401, detail="Invalid Authorization header format")
    return parts[1].strip()


def _principal_from_service_token(record: ServiceTokenRecord) -> Principal:
    return Principal(
        kind="service",
        subject=f"service:{record.token_id}",
        tenant_id=_normalize_tenant_id(record.tenant_id),
        uid=record.created_by_uid,
        scopes=tuple(sorted(record.scopes)),
        roles=(),
        service_token_id=record.token_id,
        service_name=record.name,
    )


def _principal_from_firebase_token(token: str) -> Principal:
    try:
        claims = firebase_auth.verify_bearer_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Firebase token")

    uid = str(claims.get("uid", "")).strip()
    email = str(claims.get("email", "")).strip() or None
    if not uid:
        raise HTTPException(status_code=401, detail="Token without uid")

    try:
        user_tenant = resolve_or_create_user_tenant(uid=uid, email=email)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tenant mapping failed: {exc}")

    return Principal(
        kind="user",
        subject=f"user:{user_tenant.uid}",
        tenant_id=_normalize_tenant_id(user_tenant.tenant_id),
        uid=user_tenant.uid,
        email=user_tenant.email,
        scopes=(),
        roles=(str(user_tenant.role or "owner").strip().lower(),),
    )


def resolve_principal_from_authorization(
    authorization: str | None,
    *,
    allow_service_tokens: bool = True,
    allow_anonymous_local: bool = True,
) -> Principal | None:
    raw_authorization = str(authorization or "").strip()
    if not raw_authorization:
        if allow_anonymous_local and not settings.api_auth_required:
            return None
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = _extract_bearer_token(raw_authorization)
    if allow_service_tokens and token.startswith(settings.service_token_prefix):
        service_record = verify_service_token(token)
        if service_record is not None:
            return _principal_from_service_token(service_record)
        raise HTTPException(status_code=401, detail="Invalid service token")
    return _principal_from_firebase_token(token)


def _extract_request_tenant(request: Request) -> str | None:
    path_value = request.path_params.get("tenant_id")
    if path_value:
        return _normalize_tenant_id(path_value)
    query_value = request.query_params.get("tenant_id")
    if query_value:
        return _normalize_tenant_id(query_value)
    return None


def ensure_principal_matches_tenant(principal: Principal | None, tenant_id: str | None) -> None:
    if principal is None or not tenant_id:
        return
    normalized_tenant = _normalize_tenant_id(tenant_id)
    if normalized_tenant != _normalize_tenant_id(principal.tenant_id):
        raise HTTPException(status_code=403, detail="Forbidden for tenant")


def ensure_principal_has_scopes(principal: Principal | None, scopes: Iterable[str] | None) -> None:
    if principal is None or principal.kind != "service":
        return
    required = {
        str(scope or "").strip().lower()
        for scope in (scopes or [])
        if str(scope or "").strip()
    }
    if not required:
        return
    granted = {scope.strip().lower() for scope in principal.scopes}
    missing = sorted(required - granted)
    if missing:
        raise HTTPException(status_code=403, detail="Missing service token scopes: %s" % ", ".join(missing))


def ensure_principal_has_roles(principal: Principal | None, roles: Iterable[str] | None) -> None:
    if principal is None:
        raise HTTPException(status_code=401, detail="Missing authenticated user")
    required = {
        str(role or "").strip().lower()
        for role in (roles or [])
        if str(role or "").strip()
    }
    if not required:
        return
    granted = {role.strip().lower() for role in principal.roles}
    if required.isdisjoint(granted):
        raise HTTPException(status_code=403, detail="Forbidden for role")


def require_principal(
    *,
    scopes: Iterable[str] | None = None,
    allow_service_tokens: bool = True,
    require_tenant_match: bool = True,
) -> Callable[..., Principal | None]:
    normalized_scopes = tuple(
        sorted({str(scope or "").strip().lower() for scope in (scopes or []) if str(scope or "").strip()})
    )

    async def dependency(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> Principal | None:
        subject_ip = get_request_ip(request)
        if not str(authorization or "").strip():
            enforce_rate_limit(
                bucket="public",
                subject=subject_ip,
                limit=settings.rate_limit_public_requests,
                window_seconds=settings.rate_limit_window_seconds,
            )
        principal = resolve_principal_from_authorization(
            authorization,
            allow_service_tokens=allow_service_tokens,
            allow_anonymous_local=True,
        )
        if principal is None:
            return None
        enforce_rate_limit(
            bucket=f"auth:{principal.kind}",
            subject=principal.subject,
            limit=settings.rate_limit_authenticated_requests,
            window_seconds=settings.rate_limit_window_seconds,
        )
        if require_tenant_match:
            ensure_principal_matches_tenant(principal, _extract_request_tenant(request))
        ensure_principal_has_scopes(principal, normalized_scopes)
        return principal

    return dependency


def require_user_principal(
    *,
    require_tenant_match: bool = True,
) -> Callable[..., Principal | None]:
    return require_principal(
        scopes=(),
        allow_service_tokens=False,
        require_tenant_match=require_tenant_match,
    )
