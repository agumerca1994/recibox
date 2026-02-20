from __future__ import annotations

import argparse

from app.core.config import settings
from app.services.storage.gdrive_ops import ensure_employee_folder, ensure_year_folder


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Drive folder creation (Empleado/Año)")
    parser.add_argument("--empleado", required=True)
    parser.add_argument("--anio", required=True)
    args = parser.parse_args()

    print("Root folder:", settings.drive_root_folder_id)
    try:
        emp = ensure_employee_folder(settings.drive_root_folder_id, args.empleado)
    except Exception as exc:
        print("ERROR: Failed to ensure employee folder.")
        print("DETAILS:", exc)
        return 1
    print("Employee folder:", emp.get("id"), emp.get("name"))

    try:
        year = ensure_year_folder(emp["id"], args.anio)
    except Exception as exc:
        print("ERROR: Failed to ensure year folder.")
        print("DETAILS:", exc)
        return 1
    print("Year folder:", year.get("id"), year.get("name"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
