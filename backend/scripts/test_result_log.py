from __future__ import annotations

import argparse

from app.core.config import settings
from app.services.processing.results import ProcessResult, write_result
from app.services.schemas import ExtractedInfo


def main() -> int:
    parser = argparse.ArgumentParser(description="Test processing result log")
    parser.add_argument("--file-id", default="test-file")
    parser.add_argument("--status", default="ok")
    args = parser.parse_args()

    info = ExtractedInfo(empleado="TEST", mes="01", anio="2026")
    result = ProcessResult(
        file_id=args.file_id,
        status=args.status,
        message="Test write",
        info=info,
        target={"folder_employee": "TEST", "folder_year": "2026"},
    )
    try:
        write_result(result, settings.results_log_path)
    except Exception as exc:
        print("ERROR: Failed to write result log.")
        print("DETAILS:", exc)
        return 1

    print("Wrote result to:", settings.results_log_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
