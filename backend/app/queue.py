from __future__ import annotations

from redis import Redis
from rq import Queue

from app.core.config import settings


def get_queue() -> Queue:
    return Queue("recibox", connection=get_redis())


def get_redis() -> Redis:
    return Redis.from_url(settings.redis_url)
