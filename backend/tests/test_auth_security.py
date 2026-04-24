from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import settings
from app.services.auth import google_oauth, oauth_state
from app.services.auth.principal import (
    Principal,
    ensure_principal_has_roles,
    resolve_principal_from_authorization,
)


class _FakeRedis:
    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    def setex(self, key: str, _ttl: int, value: str) -> None:
        self._values[key] = value

    def getdel(self, key: str) -> str | None:
        return self._values.pop(key, None)


class AuthSecurityTests(unittest.TestCase):
    def test_oauth_state_is_single_use_and_preserves_payload(self) -> None:
        fake_redis = _FakeRedis()
        with patch.object(settings, "app_secret_key", "unit-test-secret"), patch.object(
            settings,
            "oauth_state_ttl_seconds",
            600,
        ):
            state = oauth_state.issue_oauth_state(
                fake_redis,
                tenant_id="Tenant-1",
                popup=True,
                code_verifier="verifier-123",
                opener_origin="https://backoffice-test.recibox.com.ar",
            )
            payload = oauth_state.consume_oauth_state(fake_redis, state)

        self.assertEqual(payload["tenant_id"], "tenant-1")
        self.assertTrue(payload["popup"])
        self.assertEqual(payload["code_verifier"], "verifier-123")
        self.assertEqual(payload["opener_origin"], "https://backoffice-test.recibox.com.ar")

        with self.assertRaisesRegex(ValueError, "already used"):
            oauth_state.consume_oauth_state(fake_redis, state)

    def test_oauth_state_rejects_signature_tampering(self) -> None:
        fake_redis = _FakeRedis()
        with patch.object(settings, "app_secret_key", "unit-test-secret"):
            state = oauth_state.issue_oauth_state(
                fake_redis,
                tenant_id="tenant-1",
                popup=False,
                code_verifier="verifier-123",
                opener_origin=None,
            )

        tampered_state = f"{state}.tampered"
        with self.assertRaisesRegex(ValueError, "signature is invalid"):
            oauth_state.consume_oauth_state(fake_redis, tampered_state)

    def test_invalid_service_token_is_rejected_before_firebase_verification(self) -> None:
        with patch.object(settings, "service_token_prefix", "rbx_sk_live_"), patch(
            "app.services.auth.principal.verify_service_token",
            return_value=None,
        ), patch(
            "app.services.auth.principal.firebase_auth.verify_bearer_token"
        ) as verify_bearer_token:
            with self.assertRaises(HTTPException) as ctx:
                resolve_principal_from_authorization(
                    "Bearer rbx_sk_live_invalid-token",
                    allow_service_tokens=True,
                    allow_anonymous_local=False,
                )

        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.detail, "Invalid service token")
        verify_bearer_token.assert_not_called()

    def test_firebase_principal_includes_role_from_tenant_mapping(self) -> None:
        fake_user_tenant = SimpleNamespace(
            uid="user-1",
            email="user@example.com",
            tenant_id="Tenant-1",
            role="admin",
        )
        with patch(
            "app.services.auth.principal.firebase_auth.verify_bearer_token",
            return_value={"uid": "user-1", "email": "user@example.com"},
        ), patch(
            "app.services.auth.principal.resolve_or_create_user_tenant",
            return_value=fake_user_tenant,
        ):
            principal = resolve_principal_from_authorization(
                "Bearer firebase-token",
                allow_service_tokens=False,
                allow_anonymous_local=False,
            )

        self.assertEqual(principal.kind, "user")
        self.assertEqual(principal.tenant_id, "tenant-1")
        self.assertEqual(principal.roles, ("admin",))

    def test_role_guard_requires_matching_role(self) -> None:
        principal = Principal(
            kind="user",
            subject="user:user-1",
            tenant_id="tenant-1",
            uid="user-1",
            email="user@example.com",
            roles=("viewer",),
        )

        with self.assertRaises(HTTPException) as ctx:
            ensure_principal_has_roles(principal, {"owner", "admin"})

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, "Forbidden for role")

    def test_oauth_status_marks_reauth_required_when_refresh_token_was_revoked(self) -> None:
        class _FakeCreds:
            expired = True
            refresh_token = "refresh-token"
            valid = False
            expiry = None
            scopes = ["https://www.googleapis.com/auth/drive"]

            def refresh(self, _request) -> None:
                raise RuntimeError("invalid_grant: Token has been expired or revoked.")

        with patch("app.services.auth.google_oauth.load_credentials", return_value=_FakeCreds()), patch(
            "app.services.auth.google_oauth._missing_scopes",
            return_value=[],
        ), patch(
            "app.services.auth.google_oauth._granted_scopes",
            return_value=["https://www.googleapis.com/auth/drive"],
        ):
            status = google_oauth.get_token_status("tenant-1")

        self.assertTrue(status["has_token"])
        self.assertTrue(status["reauth_required"])
        self.assertFalse(status["valid"])
        self.assertEqual(status["status_reason"], "reauth_required")
        self.assertIn("Volve a conectar", status["refresh_error"])

    def test_refresh_tenant_credentials_returns_friendly_reauth_message(self) -> None:
        class _FakeCreds:
            refresh_token = "refresh-token"
            expiry = None

            def refresh(self, _request) -> None:
                raise RuntimeError("invalid_grant: Token has been expired or revoked.")

        with patch("app.services.auth.google_oauth.load_credentials", return_value=_FakeCreds()):
            with self.assertRaisesRegex(RuntimeError, "Volve a conectar la cuenta"):
                google_oauth.refresh_tenant_credentials("tenant-1")


if __name__ == "__main__":
    unittest.main()
