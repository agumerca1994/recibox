import time

import pdfplumber

from app.core.config import settings
from app.services.storage.gdrive import download_file
from app.services.pdf.extractor import _extract_text_ocr

file_id = "1-AK2tYhRLYY9830JUL9_ggY7I_szrFz7"
local_path = "tmp/ocr_compare.pdf"

try:
    download_file(file_id, local_path)
except Exception as exc:
    print("ERROR: Failed to download file from Drive.")
    print("FILE:", file_id)
    print("DETAILS:", exc)
    raise SystemExit(1)

print("OCR enabled:", settings.ocr_enabled)

start = time.perf_counter()
text_plain_parts = []
try:
    with pdfplumber.open(local_path) as pdf:
        for page in pdf.pages:
            txt = page.extract_text() or ""
            if txt:
                text_plain_parts.append(txt)
except Exception as exc:
    print("ERROR: Failed to extract embedded text with pdfplumber.")
    print("DETAILS:", exc)
    raise SystemExit(1)
text_plain = "\n".join(text_plain_parts)
plain_s = time.perf_counter() - start

start = time.perf_counter()
text_ocr = _extract_text_ocr(local_path)
ocr_s = time.perf_counter() - start

print("Plain length:", len(text_plain))
print("Plain sample:", text_plain[:400].replace("\n", " "))
print("Plain time (s):", f"{plain_s:.2f}")
print("")
print("OCR length:", len(text_ocr))
print("OCR sample:", (text_ocr[:400] if text_ocr else "").replace("\n", " "))
print("OCR time (s):", f"{ocr_s:.2f}")

if not text_ocr:
    print("\nTip: OCR returned empty text. Check that Tesseract/Poppler are installed and OCR_LANG is valid.")
