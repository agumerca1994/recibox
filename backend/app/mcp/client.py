from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.services.schemas import ExtractedInfo


@dataclass
class McpResult:
    extracted: ExtractedInfo
    raw: dict | None = None


class McpClient(Protocol):
    def extract_info(self, text: str) -> McpResult:
        """Extract structured info from raw text."""
        raise NotImplementedError


class NoopMcpClient:
    """Fallback client that returns an empty result."""

    def extract_info(self, text: str) -> McpResult:
        return McpResult(extracted=ExtractedInfo(), raw=None)
