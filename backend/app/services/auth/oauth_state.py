from __future__ import annotations

from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timezone
import hashlib
import hmac
import json
import secrets
from typing import Any

from redis import Redis

from app.core.config import settings


def _b64encode(data: bytes) -> str:
    return urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return urlsafe_b64decode((data + padding).encode("ascii"))


def _sign(payload: str) -> str:
    secret = settings.app_secret_key.encode("utf-8")
    return _b64encode(hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).digest())


def issue_oauth_state(
    redis_conn: Redis,
    *,
    tenant_id: str,
    popup: bool,
    code_verifier: str,
    opener_origin: str | None,
) -> str:
    nonce = secrets.token_urlsafe(24)
    payload = {
        "v": 1,
        "tenant_id": str(tenant_id or "").strip().lower(),
        "popup": bool(popup),
        "nonce": nonce,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    serialized_payload = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    state = f"{_b64encode(serialized_payload.encode('utf-8'))}.{_sign(serialized_payload)}"
    stored_payload = {
        "tenant_id": payload["tenant_id"],
        "popup": payload["popup"],
        "code_verifier": str(code_verifier or "").strip(),
        "opener_origin": str(opener_origin or "").strip() or None,
    }
    redis_conn.setex(
        f"recibox:oauth_state:{nonce}",
        max(int(settings.oauth_state_ttl_seconds), 60),
        json.dumps(stored_payload, separators=(",", ":"), sort_keys=True),
    )
    return state


def consume_oauth_state(redis_conn: Redis, state: str) -> dict[str, Any]:
    raw_state = str(state or "").strip()
    if "." not in raw_state:
        raise ValueError("OAuth state is invalid")
    encoded_payload, signature = raw_state.split(".", 1)
    try:
        payload_json = _b64decode(encoded_payload).decode("utf-8")
    except Exception as exc:
        raise ValueError("OAuth state payload is invalid") from exc
    expected_signature = _sign(payload_json)
    if not hmac.compare_digest(signature, expected_signature):
        raise ValueError("OAuth state signature is invalid")

    try:
        payload = json.loads(payload_json)
    except Exception as exc:
        raise ValueError("OAuth state JSON is invalid") from exc
    if not isinstance(payload, dict):
        raise ValueError("OAuth state has invalid shape")

    nonce = str(payload.get("nonce") or "").strip()
    tenant_id = str(payload.get("tenant_id") or "").strip().lower()
    if not nonce or not tenant_id:
        raise ValueError("OAuth state is incomplete")

    redis_key = f"recibox:oauth_state:{nonce}"
    stored = redis_conn.getdel(redis_key)
    if not stored:
        raise ValueError("OAuth state is expired or already used")

    try:
        stored_payload = json.loads(stored)
    except Exception as exc:
        raise ValueError("Stored OAuth state is invalid") from exc
    if not isinstance(stored_payload, dict):
        raise ValueError("Stored OAuth state has invalid shape")
    if str(stored_payload.get("tenant_id") or "").strip().lower() != tenant_id:
        raise ValueError("OAuth state tenant mismatch")

    return {
        "tenant_id": tenant_id,
        "popup": bool(stored_payload.get("popup")),
        "code_verifier": str(stored_payload.get("code_verifier") or "").strip() or None,
        "opener_origin": str(stored_payload.get("opener_origin") or "").strip() or None,
    }
