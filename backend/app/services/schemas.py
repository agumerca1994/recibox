from __future__ import annotations

from dataclasses import dataclass

@dataclass
class ExtractedInfo:
    empleado: str | None = None
    cuit: str | None = None
    legajo: str | None = None
    fecha: str | None = None
    mes: str | None = None
    anio: str | None = None
    fecha_pago: str | None = None

