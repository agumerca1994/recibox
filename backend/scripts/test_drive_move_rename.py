from __future__ import annotations

import argparse

from app.services.storage.gdrive_ops import move_and_rename_file


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Drive move & rename")
    parser.add_argument("--file-id", required=True)
    parser.add_argument("--folder-id", required=True)
    parser.add_argument("--new-name", required=True)
    args = parser.parse_args()

    try:
        updated = move_and_rename_file(args.file_id, args.folder_id, args.new_name)
    except Exception as exc:
        print("ERROR: Failed to move/rename file.")
        print("DETAILS:", exc)
        return 1
    print("Moved & renamed:", updated.get("id"), updated.get("name"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
