from app.core.config import settings
from app.services.processing.processor import find_latest_download
from app.services.pdf.extractor import extract_text_from_pdf, parse_fields

try:
    latest = find_latest_download(settings.local_download_dir)
except Exception as exc:
    print("ERROR: No local PDF available to process.")
    print("DETAILS:", exc)
    raise SystemExit(1)

try:
    text = extract_text_from_pdf(str(latest))
except Exception as exc:
    print("ERROR: PDF extraction failed.")
    print("FILE:", latest)
    print("DETAILS:", exc)
    raise SystemExit(1)

if not text.strip():
    print("ERROR: Extracted text is empty. PDF may be scanned or extraction failed.")
    print("FILE:", latest)
    raise SystemExit(1)

info = parse_fields(text)

missing = []
if not info.empleado:
    missing.append("empleado")
if not info.mes:
    missing.append("mes")
if not info.anio:
    missing.append("anio")

print("Using local file:", latest)
print(info)
if missing:
    print("WARNING: Parse incomplete. Missing fields:", ", ".join(missing))
