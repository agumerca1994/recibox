from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.schemas import ExtractedInfo


@dataclass
class ProcessResult:
    file_id: str
    status: str
    message: str
    info: ExtractedInfo | None = None
    target: dict | None = None
    error: str | None = None
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


def write_result(result: ProcessResult, log_path: str | Path) -> None:
    path = Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    payload: dict[str, Any] = asdict(result)
    if result.info is not None:
        payload["info"] = asdict(result.info)

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
