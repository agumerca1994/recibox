from __future__ import annotations

from pathlib import Path

from app.services.pdf.extractor import extract_text_from_pdf, parse_fields
from app.services.processing.classifier import classify


def _find_local_pdf(file_id: str, download_dir: str | Path) -> Path:
    base = Path(download_dir)
    if not base.exists():
        raise FileNotFoundError(f"Download dir not found: {base}")

    candidates = list(base.glob(f"{file_id}*.pdf"))
    if not candidates:
        raise FileNotFoundError(f"No local PDF found for file_id={file_id} in {base}")

    return candidates[0]


def find_latest_download(download_dir: str | Path) -> Path:
    base = Path(download_dir)
    if not base.exists():
        raise FileNotFoundError(f"Download dir not found: {base}")

    pdfs = list(base.glob("*.pdf"))
    if not pdfs:
        raise FileNotFoundError(f"No PDFs found in {base}")

    return max(pdfs, key=lambda p: p.stat().st_mtime)


def process_downloaded_file(file_id: str, download_dir: str | Path) -> dict:
    local_path = _find_local_pdf(file_id, download_dir)
    text = extract_text_from_pdf(str(local_path))
    info = parse_fields(text)
    target = classify(info)
    return {
        "file_id": file_id,
        "local_path": str(local_path),
        "text_len": len(text),
        "info": info,
        "target": target,
    }
