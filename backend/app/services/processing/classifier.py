from __future__ import annotations

from app.services.schemas import ExtractedInfo


def _token_value(token: str, *, mes: str, anio: str, empleado: str) -> str:
    if token == "NONE":
        return ""
    if token == "MM":
        return mes
    if token == "YYYY":
        return anio
    return empleado


def _normalize_separator(value: str) -> str:
    if value == ")":
        return ") "
    return value


def build_filename(
    *,
    empleado: str,
    anio: str,
    mes: str,
    mode: str = "mm_yyyy_employee",
    custom_format: dict | None = None,
) -> str:
    if mode == "yyyy_mm_employee":
        return f"{anio}-{mes}) {empleado}.pdf"
    if mode == "yyyy_employee":
        return f"{anio}) {empleado}.pdf"
    if mode == "custom":
        custom = custom_format or {}
        part1 = _token_value(custom.get("part1", "MM"), mes=mes, anio=anio, empleado=empleado)
        part2 = _token_value(custom.get("part2", "YYYY"), mes=mes, anio=anio, empleado=empleado)
        part3 = _token_value(custom.get("part3", "EMPLOYEE"), mes=mes, anio=anio, empleado=empleado)
        sep1 = _normalize_separator(str(custom.get("sep1", "-")))
        sep2 = _normalize_separator(str(custom.get("sep2", ")")))
        return f"{part1}{sep1}{part2}{sep2}{part3}.pdf"
    # Default: mm_yyyy_employee
    return f"{mes}-{anio}) {empleado}.pdf"


def build_employee_folder_name(
    *,
    empleado: str,
    mode: str = "indexed_number",
    custom_part1: str = "",
    custom_part2: str = "",
) -> str:
    if mode == "custom":
        fixed_prefix = f"{(custom_part1 or '').strip()}{(custom_part2 or '').strip()}".strip()
        if fixed_prefix:
            return f"{fixed_prefix} {empleado}".strip()
    return empleado


def classify(
    info: ExtractedInfo,
    *,
    filename_format_mode: str = "mm_yyyy_employee",
    filename_custom_format: dict | None = None,
    employee_folder_number_mode: str = "indexed_number",
    employee_folder_number_custom_part1: str = "",
    employee_folder_number_custom_part2: str = "",
) -> dict:
    # Resultado esperado: folder_employee, folder_year, new_filename
    empleado = (info.empleado or "SIN_EMPLEADO").strip()
    anio = (info.anio or "SIN_ANIO").strip()
    mes = (info.mes or "SIN_MES").strip()

    new_filename = build_filename(
        empleado=empleado,
        anio=anio,
        mes=mes,
        mode=filename_format_mode,
        custom_format=filename_custom_format,
    )
    folder_employee = build_employee_folder_name(
        empleado=empleado,
        mode=employee_folder_number_mode,
        custom_part1=employee_folder_number_custom_part1,
        custom_part2=employee_folder_number_custom_part2,
    )
    return {
        "folder_employee": folder_employee,
        "folder_year": anio,
        "new_filename": new_filename,
    }
