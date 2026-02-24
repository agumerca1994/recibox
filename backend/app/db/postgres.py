from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from app.core.config import settings


def require_postgres_url() -> str:
    url = (settings.postgres_url or "").strip()
    if not url:
        raise RuntimeError("POSTGRES_URL is not configured")
    return url


@contextmanager
def get_postgres_conn() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(require_postgres_url())
    try:
        yield conn
    finally:
        conn.close()

