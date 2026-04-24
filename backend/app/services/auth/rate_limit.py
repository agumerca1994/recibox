from __future__ import annotations

from fastapi import HTTPException, Request

from app.queue import get_redis


def get_request_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for.strip():
        return forwarded_for.split(",", 1)[0].strip() or "unknown"
    client = request.client
    return getattr(client, "host", None) or "unknown"


def enforce_rate_limit(*, bucket: str, subject: str, limit: int, window_seconds: int) -> None:
    normalized_bucket = str(bucket or "").strip().lower() or "default"
    normalized_subject = str(subject or "").strip().lower() or "unknown"
    max_limit = max(int(limit or 0), 1)
    ttl = max(int(window_seconds or 0), 1)
    redis_conn = get_redis()
    key = f"recibox:rate_limit:{normalized_bucket}:{normalized_subject}"
    try:
        current = int(redis_conn.incr(key))
        if current == 1:
            redis_conn.expire(key, ttl)
    except Exception:
        return
    if current > max_limit:
        raise HTTPException(status_code=429, detail="Too many requests")
