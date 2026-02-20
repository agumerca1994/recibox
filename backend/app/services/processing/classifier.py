from __future__ import annotations

from app.services.schemas import ExtractedInfo


def classify(info: ExtractedInfo) -> dict:
    # Resultado esperado: folder_employee, folder_year, new_filename
    empleado = (info.empleado or "SIN_EMPLEADO").strip()
    anio = (info.anio or "SIN_ANIO").strip()
    mes = (info.mes or "SIN_MES").strip()

    new_filename = f"{mes}-{anio}) {empleado}.pdf"
    return {
        "folder_employee": empleado,
        "folder_year": anio,
        "new_filename": new_filename,
    }
