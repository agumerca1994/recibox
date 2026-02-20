from __future__ import annotations

import argparse
import time
from pathlib import Path

from app.core.config import settings
from app.services.storage.gdrive import (
    create_folder,
    delete_file,
    download_file,
    list_files_in_folder,
    move_and_rename,
    update_file_metadata,
    upload_file,
)


def _make_min_pdf(path: Path) -> None:
    pdf_bytes = (
        b"%PDF-1.4\n"
        b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n"
        b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n"
        b"3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>endobj\n"
        b"4 0 obj<< /Length 44 >>stream\n"
        b"BT /F1 12 Tf 10 100 Td (RECIBOX TEST) Tj ET\n"
        b"endstream endobj\n"
        b"xref\n0 5\n0000000000 65535 f \n"
        b"0000000010 00000 n \n0000000060 00000 n \n0000000112 00000 n \n0000000213 00000 n \n"
        b"trailer<< /Size 5 /Root 1 0 R >>\nstartxref\n316\n%%EOF\n"
    )
    path.write_bytes(pdf_bytes)


def main() -> int:
    parser = argparse.ArgumentParser(description="RECIBOX Drive full test")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    print("Using root folder:", settings.drive_root_folder_id)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    try:
        test_root = create_folder(settings.drive_root_folder_id, f"__recibox_test_{stamp}")
    except Exception as exc:
        print("ERROR: Failed to create test root folder in Drive.")
        print("DETAILS:", exc)
        return 1
    print("Created test folder:", test_root["id"], test_root["name"])

    local_dir = Path("tmp")
    try:
        local_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print("ERROR: Failed to create local temp directory.")
        print("DIR:", local_dir)
        print("DETAILS:", exc)
        return 1
    local_pdf = local_dir / f"recibox_test_{stamp}.pdf"
    try:
        _make_min_pdf(local_pdf)
    except Exception as exc:
        print("ERROR: Failed to create local test PDF.")
        print("DETAILS:", exc)
        return 1

    try:
        uploaded = upload_file(
            str(local_pdf),
            parent_id=test_root["id"],
            name=local_pdf.name,
            mime_type="application/pdf",
        )
    except Exception as exc:
        print("ERROR: Failed to upload test PDF to Drive.")
        print("DETAILS:", exc)
        return 1
    print("Uploaded:", uploaded["id"], uploaded["name"])

    try:
        updated = update_file_metadata(uploaded["id"], new_name=f"renamed_{local_pdf.name}")
    except Exception as exc:
        print("ERROR: Failed to rename test PDF in Drive.")
        print("DETAILS:", exc)
        return 1
    print("Renamed:", updated["name"])

    try:
        subfolder = create_folder(test_root["id"], "subfolder")
    except Exception as exc:
        print("ERROR: Failed to create subfolder in Drive.")
        print("DETAILS:", exc)
        return 1
    print("Created subfolder:", subfolder["id"], subfolder["name"])

    try:
        moved = move_and_rename(uploaded["id"], subfolder["id"], f"moved_{local_pdf.name}")
    except Exception as exc:
        print("ERROR: Failed to move/rename test PDF in Drive.")
        print("DETAILS:", exc)
        return 1
    print("Moved & renamed:", moved["id"], moved["name"])

    print("Listing files in subfolder:")
    try:
        for f in list_files_in_folder(subfolder["id"]):
            print(f"- {f['id']}  {f['name']}")
    except Exception as exc:
        print("ERROR: Failed to list files in subfolder.")
        print("DETAILS:", exc)
        return 1

    print("Downloading moved file...")
    download_path = local_dir / f"downloaded_{stamp}.pdf"
    try:
        download_file(moved["id"], str(download_path))
        if not download_path.exists() or download_path.stat().st_size == 0:
            print("ERROR: Download completed but file is missing or empty.")
            print("PATH:", download_path)
            return 1
    except Exception as exc:
        print("ERROR: Failed to download moved test PDF.")
        print("DETAILS:", exc)
        return 1
    print("Downloaded OK ->", download_path)

    if args.cleanup:
        print("Cleanup enabled. Deleting test files/folders...")
        try:
            delete_file(moved["id"])
            delete_file(subfolder["id"])
            delete_file(test_root["id"])
        except Exception as exc:
            print("ERROR: Cleanup failed. Some test artifacts may remain.")
            print("DETAILS:", exc)
            return 1
        print("Cleanup done.")
    else:
        print("Cleanup skipped. Test folder retained:", test_root["id"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
