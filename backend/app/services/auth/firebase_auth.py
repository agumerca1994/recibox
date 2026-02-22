from __future__ import annotations

from functools import lru_cache

import firebase_admin
from firebase_admin import auth, credentials
from firebase_admin.exceptions import FirebaseError

from app.core.config import settings


@lru_cache(maxsize=1)
def _init_firebase_app() -> firebase_admin.App:
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    cred_path = (settings.firebase_credentials_path or settings.google_application_credentials or "").strip()
    options = {}
    if settings.firebase_project_id:
        options["projectId"] = settings.firebase_project_id
    if cred_path:
        cred = credentials.Certificate(cred_path)
        return firebase_admin.initialize_app(cred, options=options or None)
    return firebase_admin.initialize_app(options=options or None)


def verify_bearer_token(token: str) -> dict:
    _init_firebase_app()
    try:
        return auth.verify_id_token(token)
    except FirebaseError as exc:
        raise RuntimeError(str(exc)) from exc
