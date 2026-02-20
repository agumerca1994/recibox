from __future__ import annotations

import re
from datetime import datetime
from typing import Iterable

import pdfplumber

from app.core.config import settings

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover
    fitz = None

from app.services.schemas import ExtractedInfo

try:
    from pdf2image import convert_from_path
except Exception:  # pragma: no cover
    convert_from_path = None

try:
    import pytesseract
except Exception:  # pragma: no cover
    pytesseract = None


def extract_text_from_pdf(path: str) -> str:
    text_parts: list[str] = []
    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                txt = page.extract_text() or ""
                if txt:
                    text_parts.append(txt)
    except Exception:
        text_parts = []

    text = "\n".join(text_parts) if text_parts else ""
    if text:
        if len(text) >= settings.ocr_min_text_len:
            return text
        if settings.ocr_enabled:
            ocr_text = _extract_text_ocr(path)
            return ocr_text or text
        return text

    if fitz is None:
        raise RuntimeError("No PDF extractor available (pdfplumber and pymupdf failed).")

    try:
        doc = fitz.open(path)
        for page in doc:
            text_parts.append(page.get_text("text"))
        doc.close()
    except Exception as exc:
        raise RuntimeError(f"PDF extraction failed: {exc}") from exc

    text = "\n".join(text_parts)
    if text:
        return text

    if settings.ocr_enabled:
        ocr_text = _extract_text_ocr(path)
        return ocr_text or text

    return text


def parse_fields(text: str) -> ExtractedInfo:
    norm = _normalize_text(text)

    empleado = _match_first(
        norm,
        [
            r"EMPLEADO[:\s]+([A-ZÁÉÍÓÚÜÑ0-9 ,.'-]{3,}?)(?:\s+LEGAJO|\s+CUIL|\s+C\.U\.I\.L|\s+FEC|\s*$)",
            r"NOMBRE\s*:\s*([A-ZÁÉÍÓÚÜÑ0-9 ,.'-]{3,}?)(?:\s+LEGAJO|\s+CUIL|\s+C\.U\.I\.L|\s+FEC|\s*$)",
        ],
    )

    cuil = _match_first(
        norm,
        [
            r"C\.?U\.?I\.?L\.?[:\s]+([0-9\-]{10,})",
            r"CUIL[:\s]+([0-9\-]{10,})",
        ],
    )
    cuit = _match_first(
        norm,
        [
            r"C\.?U\.?I\.?T\.?[:\s]+([0-9\-]{10,})",
            r"CUIT[:\s]+([0-9\-]{10,})",
        ],
    )

    legajo = _match_first(norm, [r"LEGAJO\s*:\s*([A-Z0-9\-]{2,})"])

    fecha = _match_first(
        norm,
        [
            r"FECHA\.\s*:\s*([0-9]{2}/[0-9]{2}/[0-9]{4})",
            r"FECHA[:\s]+([0-9]{2}/[0-9]{2}/[0-9]{4})",
        ],
    )

    fecha_pago = _match_first(
        norm,
        [
            r"FECHA DE PAGO[:\s]+([0-9]{2}/[0-9]{2}/[0-9]{4})",
            r"FECHA PAGO[:\s]+([0-9]{2}/[0-9]{2}/[0-9]{4})",
        ],
    )

    mes_anio = _match_first(norm, [r"\b([0-9]{2}/[0-9]{4})\b"])

    mes = _match_first(
        norm,
        [
            r"MES[:\s]+([A-Z]+)",
            r"MES[:\s]+([0-9]{2})",
        ],
    )

    anio = _match_first(norm, [r"AÑO[:\s]+([0-9]{4})", r"ANIO[:\s]+([0-9]{4})"])

    if not mes or not anio:
        mes, anio = _derive_mes_anio(mes, anio, fecha, mes_anio)

    return ExtractedInfo(
        empleado=_clean_name(empleado),
        cuit=_clean_digits(cuil or cuit),
        legajo=legajo,
        fecha=fecha,
        mes=mes,
        anio=anio,
        fecha_pago=fecha_pago,
    )


def _normalize_text(text: str) -> str:
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    return text.upper()


def _match_first(text: str, patterns: Iterable[str]) -> str | None:
    for pat in patterns:
        m = re.search(pat, text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    return None


def _clean_name(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"\s+", " ", value).strip(" -")
    return value


def _clean_digits(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"[^0-9]", "", value)


def _derive_mes_anio(
    mes: str | None, anio: str | None, fecha: str | None, mes_anio: str | None
) -> tuple[str | None, str | None]:
    if (mes and anio) or (not fecha and not mes_anio):
        return mes, anio

    if mes_anio:
        try:
            mm, yy = mes_anio.split("/")
            return _mes_from_number(mm), yy
        except Exception:
            pass

    if fecha:
        try:
            dt = datetime.strptime(fecha, "%d/%m/%Y")
            return f"{dt.month:02d}", str(dt.year)
        except Exception:
            pass

    return mes, anio


def _mes_from_number(mm: str | None) -> str | None:
    if not mm:
        return None
    mm = mm.strip()
    if not mm.isdigit():
        return mm
    return mm.zfill(2)


def _extract_text_ocr(path: str) -> str:
    if pytesseract is None or convert_from_path is None:
        return ""

    try:
        images = convert_from_path(path, dpi=300)
    except Exception:
        return ""

    parts: list[str] = []
    for img in images:
        try:
            parts.append(pytesseract.image_to_string(img, lang=settings.ocr_lang))
        except Exception:
            continue

    return "\n".join(p for p in parts if p)
