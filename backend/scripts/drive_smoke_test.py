from __future__ import annotations

import argparse
from pathlib import Path

from app.services.storage.gdrive import download_file, list_files_in_folder
from app.core.config import settings


def main() -> int:
    parser = argparse.ArgumentParser(description="RECIBOX Drive smoke test")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()

    print("Input folder:", settings.drive_input_folder_id)
    try:
        files = list(
            list_files_in_folder(
                settings.drive_input_folder_id, query_extra="mimeType = 'application/pdf'"
            )
        )
    except Exception as exc:
        print("ERROR: Failed to list files from Drive INPUT folder.")
        print("DETAILS:", exc)
        return 1

    if not files:
        print("ERROR: No PDF files found in the INPUT folder.")
        return 0

    for f in files[: args.limit]:
        print(f"- {f['id']}  {f['name']}")

    if args.download:
        target_dir = Path(settings.local_download_dir)
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            print("ERROR: Failed to create local download directory.")
            print("DIR:", target_dir)
            print("DETAILS:", exc)
            return 1
        first = files[0]
        dest = target_dir / f"{first['id']}.pdf"
        print("Downloading:", first["name"], "->", dest)
        try:
            download_file(first["id"], str(dest))
            if not dest.exists() or dest.stat().st_size == 0:
                print("ERROR: Download completed but file is missing or empty.")
                print("PATH:", dest)
                return 1
        except Exception as exc:
            print("ERROR: Failed to download file from Drive.")
            print("FILE:", first["id"], first["name"])
            print("DETAILS:", exc)
            return 1
        print("Downloaded OK.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
