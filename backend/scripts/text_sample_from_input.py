from pathlib import Path

from app.core.config import settings
from app.services.storage.gdrive import list_files_in_folder, download_file
from app.services.pdf.extractor import extract_text_from_pdf

try:
    files = list(
        list_files_in_folder(settings.drive_input_folder_id, query_extra="mimeType = 'application/pdf'")
    )
except Exception as exc:
    print("ERROR: Failed to list files from Drive INPUT folder.")
    print("DETAILS:", exc)
    raise SystemExit(1)

if not files:
    print("ERROR: No PDFs found in INPUT folder.")
    raise SystemExit(0)

f = files[0]
print("Using:", f["id"], f["name"])

local_path = Path(settings.local_download_dir) / f"{f['id']}.pdf"
try:
    local_path.parent.mkdir(parents=True, exist_ok=True)
except Exception as exc:
    print("ERROR: Failed to create local download directory.")
    print("DIR:", local_path.parent)
    print("DETAILS:", exc)
    raise SystemExit(1)

try:
    download_file(f["id"], str(local_path))
except Exception as exc:
    print("ERROR: Failed to download file from Drive.")
    print("FILE:", f["id"], f["name"])
    print("DETAILS:", exc)
    raise SystemExit(1)

try:
    text = extract_text_from_pdf(str(local_path))
except Exception as exc:
    print("ERROR: PDF extraction failed.")
    print("FILE:", local_path)
    print("DETAILS:", exc)
    raise SystemExit(1)

print("--- TEXT SAMPLE (first 2000 chars) ---")
if not text.strip():
    print("ERROR: Extracted text is empty. PDF may be scanned or extraction failed.")
else:
    print(text[:2000])
