from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

if "psycopg" not in sys.modules:
    fake_psycopg = types.ModuleType("psycopg")
    fake_psycopg.Connection = object
    fake_psycopg.connect = lambda *args, **kwargs: None
    sys.modules["psycopg"] = fake_psycopg

if "rq" not in sys.modules:
    fake_rq = types.ModuleType("rq")

    class _FakeQueue:
        def __init__(self, *args, **kwargs) -> None:
            pass

    fake_rq.Queue = _FakeQueue
    fake_rq.get_current_job = lambda: None
    sys.modules["rq"] = fake_rq

from app.services.schemas import ExtractedInfo
from app.services.templates.processor import (
    MISSING_FOLDER_STRUCTURE_MESSAGE,
    _process_one_template_document,
    _resolve_folder_by_policy,
)


def _name_part(*, node_id: str, part_type: str, field_key: str | None = None, literal_value: str | None = None) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        part_id=f"part-{node_id}-{part_type}",
        node_id=node_id,
        part_order=0,
        part_type=part_type,
        field_key=field_key,
        literal_value=literal_value,
        index_kind=None,
        index_start_numeric=None,
        index_start_alpha=None,
        index_direction=None,
        created_at=now,
    )


def _index_name_part(
    *,
    node_id: str,
    index_kind: str = "numeric",
    index_direction: str = "incremental",
    index_start_numeric: int | None = None,
    index_start_alpha: str | None = None,
) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        part_id=f"part-{node_id}-index",
        node_id=node_id,
        part_order=0,
        part_type="index",
        field_key=None,
        literal_value=None,
        index_kind=index_kind,
        index_start_numeric=index_start_numeric,
        index_start_alpha=index_start_alpha,
        index_direction=index_direction,
        created_at=now,
    )


def _node(
    *,
    node_id: str,
    node_order: int,
    node_type: str,
    conflict_policy: str | None,
    name_parts: list[SimpleNamespace],
) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        node_id=node_id,
        rule_id="rule-1",
        node_order=node_order,
        node_type=node_type,
        conflict_policy=conflict_policy,
        name_parts=name_parts,
        created_at=now,
    )


class TemplateProcessorTests(unittest.TestCase):
    def test_resolve_folder_by_policy_reuses_existing_when_create_if_missing_enabled(self) -> None:
        existing_folder = {"id": "folder-123", "name": "Empresa"}
        with patch("app.services.templates.processor._list_child_folders", return_value=[existing_folder]), patch(
            "app.services.templates.processor.gdrive.create_folder"
        ) as create_folder:
            folder, created_new = _resolve_folder_by_policy(
                parent_id="root-1",
                folder_name="Empresa",
                conflict_policy="create_new",
                tenant_id="tenant-1",
            )

        self.assertEqual(folder, existing_folder)
        self.assertFalse(created_new)
        create_folder.assert_not_called()

    def test_resolve_folder_by_policy_fails_when_missing_and_creation_disabled(self) -> None:
        with patch("app.services.templates.processor._list_child_folders", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "Missing folder 'Empresa'"):
                _resolve_folder_by_policy(
                    parent_id="root-1",
                    folder_name="Empresa",
                    conflict_policy="use_existing",
                    tenant_id="tenant-1",
                )

    def test_process_document_returns_requested_message_when_folder_structure_is_missing(self) -> None:
        folder_node = _node(
            node_id="node-folder",
            node_order=0,
            node_type="folder",
            conflict_policy="use_existing",
            name_parts=[_name_part(node_id="node-folder", part_type="field", field_key="empleado")],
        )
        file_node = _node(
            node_id="node-file",
            node_order=1,
            node_type="file",
            conflict_policy=None,
            name_parts=[_name_part(node_id="node-file", part_type="literal", literal_value="recibo")],
        )
        rule = SimpleNamespace(
            rule_id="rule-1",
            tenant_id="tenant-1",
            template_id="template-1",
            rule_status="ready",
            nodes=[folder_node, file_node],
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        template = SimpleNamespace(
            template_id="template-1",
            group_id="group-1",
            group_name="Grupo Sueldos",
            custom_model={"fields": []},
        )

        with patch("app.services.templates.processor.gdrive.download_file", return_value=None), patch(
            "app.services.templates.processor.extract_text_from_pdf", return_value=""
        ), patch(
            "app.services.templates.processor.parse_fields", return_value=ExtractedInfo(empleado="Empresa")
        ), patch(
            "app.services.templates.processor._extract_document_values", return_value={"empleado": "Empresa"}
        ), patch(
            "app.services.templates.processor._list_child_folders", return_value=[]
        ), patch(
            "app.services.templates.processor._list_child_files", return_value=[]
        ), patch("app.services.templates.processor.gdrive.move_and_rename") as move_and_rename:
            result = _process_one_template_document(
                {"id": "file-1", "name": "recibo.pdf"},
                tenant_id="tenant-1",
                drive_root_folder_id="root-1",
                template=template,
                classification_rule=rule,
                field_definitions=[],
                field_transform_groups=[],
                child_name_cache={},
            )

        self.assertEqual(result.status, "error")
        self.assertEqual(result.message, MISSING_FOLDER_STRUCTURE_MESSAGE)
        self.assertIn("Missing folder 'Empresa'", result.error or "")
        move_and_rename.assert_not_called()

    def test_process_document_reuses_existing_parent_and_creates_missing_child_when_enabled(self) -> None:
        folder_node = _node(
            node_id="node-folder-1",
            node_order=0,
            node_type="folder",
            conflict_policy="create_new",
            name_parts=[_name_part(node_id="node-folder-1", part_type="field", field_key="empleado")],
        )
        year_node = _node(
            node_id="node-folder-2",
            node_order=1,
            node_type="folder",
            conflict_policy="create_new",
            name_parts=[_name_part(node_id="node-folder-2", part_type="field", field_key="anio")],
        )
        file_node = _node(
            node_id="node-file",
            node_order=2,
            node_type="file",
            conflict_policy=None,
            name_parts=[_name_part(node_id="node-file", part_type="literal", literal_value="recibo")],
        )
        rule = SimpleNamespace(
            rule_id="rule-1",
            tenant_id="tenant-1",
            template_id="template-1",
            rule_status="ready",
            nodes=[folder_node, year_node, file_node],
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        template = SimpleNamespace(
            template_id="template-1",
            group_id="group-1",
            group_name="Grupo Sueldos",
            custom_model={"fields": []},
        )
        existing_employee_folder = {"id": "folder-employee", "name": "Empresa"}
        created_year_folder = {"id": "folder-year", "name": "2026"}

        with patch("app.services.templates.processor.gdrive.download_file", return_value=None), patch(
            "app.services.templates.processor.extract_text_from_pdf", return_value=""
        ), patch(
            "app.services.templates.processor.parse_fields", return_value=ExtractedInfo(empleado="Empresa", anio="2026")
        ), patch(
            "app.services.templates.processor._extract_document_values",
            return_value={"empleado": "Empresa", "anio": "2026"},
        ), patch(
            "app.services.templates.processor._list_child_folders",
            side_effect=[
                [existing_employee_folder],
                [existing_employee_folder],
                [],
                [],
                [],
            ],
        ), patch(
            "app.services.templates.processor._list_child_files", return_value=[]
        ), patch(
            "app.services.templates.processor.gdrive.create_folder", return_value=created_year_folder
        ) as create_folder, patch("app.services.templates.processor.gdrive.move_and_rename") as move_and_rename:
            result = _process_one_template_document(
                {"id": "file-1", "name": "recibo.pdf"},
                tenant_id="tenant-1",
                drive_root_folder_id="root-1",
                template=template,
                classification_rule=rule,
                field_definitions=[],
                field_transform_groups=[],
                child_name_cache={},
            )

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.target["folders"], ["Grupo Sueldos", "Empresa", "2026"])
        create_folder.assert_called_once_with("folder-employee", "2026", tenant_id="tenant-1")
        move_and_rename.assert_called_once_with("file-1", "folder-year", "recibo.pdf", tenant_id="tenant-1")

    def test_process_document_returns_requested_message_when_nested_folder_is_missing(self) -> None:
        folder_node = _node(
            node_id="node-folder-1",
            node_order=0,
            node_type="folder",
            conflict_policy="use_existing",
            name_parts=[_name_part(node_id="node-folder-1", part_type="field", field_key="empleado")],
        )
        year_node = _node(
            node_id="node-folder-2",
            node_order=1,
            node_type="folder",
            conflict_policy="use_existing",
            name_parts=[_name_part(node_id="node-folder-2", part_type="field", field_key="anio")],
        )
        file_node = _node(
            node_id="node-file",
            node_order=2,
            node_type="file",
            conflict_policy=None,
            name_parts=[_name_part(node_id="node-file", part_type="literal", literal_value="recibo")],
        )
        rule = SimpleNamespace(
            rule_id="rule-1",
            tenant_id="tenant-1",
            template_id="template-1",
            rule_status="ready",
            nodes=[folder_node, year_node, file_node],
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        template = SimpleNamespace(
            template_id="template-1",
            group_id=None,
            group_name="",
            custom_model={"fields": []},
        )
        existing_employee_folder = {"id": "folder-employee", "name": "Empresa"}

        with patch("app.services.templates.processor.gdrive.download_file", return_value=None), patch(
            "app.services.templates.processor.extract_text_from_pdf", return_value=""
        ), patch(
            "app.services.templates.processor.parse_fields", return_value=ExtractedInfo(empleado="Empresa", anio="2026")
        ), patch(
            "app.services.templates.processor._extract_document_values",
            return_value={"empleado": "Empresa", "anio": "2026"},
        ), patch(
            "app.services.templates.processor._list_child_folders",
            side_effect=[
                [existing_employee_folder],
                [existing_employee_folder],
                [],
                [],
                [],
            ],
        ), patch(
            "app.services.templates.processor._list_child_files", return_value=[]
        ), patch("app.services.templates.processor.gdrive.move_and_rename") as move_and_rename:
            result = _process_one_template_document(
                {"id": "file-1", "name": "recibo.pdf"},
                tenant_id="tenant-1",
                drive_root_folder_id="root-1",
                template=template,
                classification_rule=rule,
                field_definitions=[],
                field_transform_groups=[],
                child_name_cache={},
            )

        self.assertEqual(result.status, "error")
        self.assertEqual(result.message, MISSING_FOLDER_STRUCTURE_MESSAGE)
        self.assertEqual(result.target["folders"], ["Empresa"])
        self.assertIn("Missing folder '2026'", result.error or "")
        move_and_rename.assert_not_called()

    def test_process_document_bootstraps_group_structure_even_when_rule_uses_existing(self) -> None:
        folder_node = _node(
            node_id="node-folder-1",
            node_order=0,
            node_type="folder",
            conflict_policy="use_existing",
            name_parts=[_name_part(node_id="node-folder-1", part_type="field", field_key="empleado")],
        )
        year_node = _node(
            node_id="node-folder-2",
            node_order=1,
            node_type="folder",
            conflict_policy="use_existing",
            name_parts=[_name_part(node_id="node-folder-2", part_type="field", field_key="anio")],
        )
        file_node = _node(
            node_id="node-file",
            node_order=2,
            node_type="file",
            conflict_policy=None,
            name_parts=[_name_part(node_id="node-file", part_type="literal", literal_value="recibo")],
        )
        rule = SimpleNamespace(
            rule_id="rule-1",
            tenant_id="tenant-1",
            template_id="template-1",
            rule_status="ready",
            nodes=[folder_node, year_node, file_node],
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        template = SimpleNamespace(
            template_id="template-1",
            group_id="group-1",
            group_name="Grupo Sueldos",
            custom_model={"fields": []},
        )
        created_employee_folder = {"id": "folder-employee", "name": "Empresa"}
        created_year_folder = {"id": "folder-year", "name": "2026"}

        with patch("app.services.templates.processor.gdrive.download_file", return_value=None), patch(
            "app.services.templates.processor.extract_text_from_pdf", return_value=""
        ), patch(
            "app.services.templates.processor.parse_fields", return_value=ExtractedInfo(empleado="Empresa", anio="2026")
        ), patch(
            "app.services.templates.processor._extract_document_values",
            return_value={"empleado": "Empresa", "anio": "2026"},
        ), patch(
            "app.services.templates.processor._list_child_folders",
            side_effect=[
                [],
                [],
                [],
                [],
                [],
                [],
            ],
        ), patch(
            "app.services.templates.processor._list_child_files", return_value=[]
        ), patch(
            "app.services.templates.processor.gdrive.create_folder",
            side_effect=[created_employee_folder, created_year_folder],
        ) as create_folder, patch("app.services.templates.processor.gdrive.move_and_rename") as move_and_rename:
            result = _process_one_template_document(
                {"id": "file-1", "name": "recibo.pdf"},
                tenant_id="tenant-1",
                drive_root_folder_id="root-1",
                template=template,
                classification_rule=rule,
                field_definitions=[],
                field_transform_groups=[],
                child_name_cache={},
            )

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.target["folders"], ["Grupo Sueldos", "Empresa", "2026"])
        self.assertEqual(
            create_folder.call_args_list,
            [
                unittest.mock.call("root-1", "Empresa", tenant_id="tenant-1"),
                unittest.mock.call("folder-employee", "2026", tenant_id="tenant-1"),
            ],
        )
        move_and_rename.assert_called_once_with("file-1", "folder-year", "recibo.pdf", tenant_id="tenant-1")

    def test_process_document_reuses_existing_indexed_folder_instead_of_creating_next_one(self) -> None:
        folder_node = _node(
            node_id="node-folder-indexed",
            node_order=0,
            node_type="folder",
            conflict_policy="create_new",
            name_parts=[
                _name_part(node_id="node-folder-indexed", part_type="literal", literal_value="Empresa "),
                _index_name_part(node_id="node-folder-indexed", index_kind="numeric", index_direction="incremental"),
            ],
        )
        file_node = _node(
            node_id="node-file",
            node_order=1,
            node_type="file",
            conflict_policy=None,
            name_parts=[_name_part(node_id="node-file", part_type="literal", literal_value="recibo")],
        )
        rule = SimpleNamespace(
            rule_id="rule-1",
            tenant_id="tenant-1",
            template_id="template-1",
            rule_status="ready",
            nodes=[folder_node, file_node],
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        template = SimpleNamespace(
            template_id="template-1",
            group_id="group-1",
            group_name="Grupo Sueldos",
            custom_model={"fields": []},
        )
        existing_folder = {"id": "folder-empresa-1", "name": "Empresa 1"}

        with patch("app.services.templates.processor.gdrive.download_file", return_value=None), patch(
            "app.services.templates.processor.extract_text_from_pdf", return_value=""
        ), patch(
            "app.services.templates.processor.parse_fields", return_value=ExtractedInfo()
        ), patch(
            "app.services.templates.processor._extract_document_values", return_value={}
        ), patch(
            "app.services.templates.processor._list_child_folders",
            side_effect=[
                [existing_folder],
                [existing_folder],
            ],
        ), patch(
            "app.services.templates.processor._list_child_files", return_value=[]
        ), patch(
            "app.services.templates.processor.gdrive.create_folder"
        ) as create_folder, patch("app.services.templates.processor.gdrive.move_and_rename") as move_and_rename:
            result = _process_one_template_document(
                {"id": "file-1", "name": "recibo.pdf"},
                tenant_id="tenant-1",
                drive_root_folder_id="root-1",
                template=template,
                classification_rule=rule,
                field_definitions=[],
                field_transform_groups=[],
                child_name_cache={},
            )

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.target["folders"], ["Grupo Sueldos", "Empresa 1"])
        create_folder.assert_not_called()
        move_and_rename.assert_called_once_with("file-1", "folder-empresa-1", "recibo.pdf", tenant_id="tenant-1")


if __name__ == "__main__":
    unittest.main()
