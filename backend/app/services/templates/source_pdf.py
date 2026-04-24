from __future__ import annotations

from pathlib import Path
import fitz

from app.core.config import settings
from app.services.storage import gdrive


PDF_SIGNATURE = b"%PDF"


def _sanitize_segment(value: str, fallback: str) -> str:
    normalized = "".join(ch for ch in str(value or "").strip() if ch.isalnum() or ch in ("-", "_"))
    return normalized or fallback


def _template_base_dir() -> Path:
    return Path(settings.local_download_dir) / "template_source_pdfs"


def get_template_source_pdf_path(*, tenant_id: str, template_id: str) -> Path:
    tenant_part = _sanitize_segment(str(tenant_id or "").lower(), "tenant")
    template_part = _sanitize_segment(template_id, "template")
    return _template_base_dir() / tenant_part / f"{template_part}.pdf"


def save_template_source_pdf(*, tenant_id: str, template_id: str, content: bytes) -> Path:
    payload = content or b""
    max_bytes = max(int(settings.max_template_source_pdf_mb), 1) * 1024 * 1024
    if len(payload) > max_bytes:
        raise ValueError(f"file exceeds {settings.max_template_source_pdf_mb} MB limit")
    if len(payload) < len(PDF_SIGNATURE) or not payload.startswith(PDF_SIGNATURE):
        raise ValueError("file must be a valid PDF")
    try:
        with fitz.open(stream=payload, filetype="pdf") as document:
            if document.page_count < 1:
                raise ValueError("file must contain at least one page")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("file must be a readable PDF") from exc

    target = get_template_source_pdf_path(tenant_id=tenant_id, template_id=template_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)
    return target


def delete_template_source_pdf(*, tenant_id: str, template_id: str) -> None:
    target = get_template_source_pdf_path(tenant_id=tenant_id, template_id=template_id)
    try:
        target.unlink(missing_ok=True)
    except Exception:
        pass


def resolve_template_source_pdf(
    *,
    tenant_id: str,
    template_id: str,
    sample_file_metadata: dict | None,
) -> Path | None:
    target = get_template_source_pdf_path(tenant_id=tenant_id, template_id=template_id)
    if target.exists() and target.stat().st_size > 0:
        return target

    metadata = sample_file_metadata or {}
    file_id = str(metadata.get("file_id", "")).strip()
    if not file_id:
        return None

    target.parent.mkdir(parents=True, exist_ok=True)
    gdrive.download_file(file_id, str(target), tenant_id=tenant_id)
    if target.exists() and target.stat().st_size > 0:
        return target
    return None
