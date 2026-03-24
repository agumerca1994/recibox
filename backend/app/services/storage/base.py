from __future__ import annotations

from typing import Iterable, Optional, Protocol


class StorageClient(Protocol):
    def list_files_in_folder(
        self,
        folder_id: str,
        *,
        query_extra: str | None = None,
        page_size: Optional[int] = None,
        fields: str | None = None,
    ) -> Iterable[dict]:
        raise NotImplementedError

    def download_file(self, file_id: str, dest_path: str) -> str:
        raise NotImplementedError

    def move_and_rename(
        self,
        file_id: str,
        folder_id: str,
        new_name: str,
        *,
        app_properties: dict[str, str | None] | None = None,
    ) -> dict:
        raise NotImplementedError

    def ensure_folder(self, parent_id: str, name: str) -> dict:
        raise NotImplementedError
