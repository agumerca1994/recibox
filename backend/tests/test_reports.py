from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

if "psycopg" not in sys.modules:
    fake_psycopg = types.ModuleType("psycopg")
    fake_psycopg.Connection = object
    fake_psycopg.connect = lambda *args, **kwargs: None
    sys.modules["psycopg"] = fake_psycopg

if "psycopg.rows" not in sys.modules:
    fake_psycopg_rows = types.ModuleType("psycopg.rows")
    fake_psycopg_rows.dict_row = object()
    sys.modules["psycopg.rows"] = fake_psycopg_rows

if "psycopg.types" not in sys.modules:
    sys.modules["psycopg.types"] = types.ModuleType("psycopg.types")

if "psycopg.types.json" not in sys.modules:
    fake_psycopg_json = types.ModuleType("psycopg.types.json")

    class _FakeJsonb:
        def __init__(self, value):
            self.value = value

    fake_psycopg_json.Jsonb = _FakeJsonb
    sys.modules["psycopg.types.json"] = fake_psycopg_json

if "redis" not in sys.modules:
    fake_redis = types.ModuleType("redis")

    class _FakeRedis:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            return cls()

    fake_redis.Redis = _FakeRedis
    sys.modules["redis"] = fake_redis

if "rq" not in sys.modules:
    fake_rq = types.ModuleType("rq")

    class _FakeQueue:
        def __init__(self, *args, **kwargs) -> None:
            pass

    fake_rq.Queue = _FakeQueue
    fake_rq.get_current_job = lambda: None
    sys.modules["rq"] = fake_rq

if "rq.job" not in sys.modules:
    fake_rq_job = types.ModuleType("rq.job")
    fake_rq_job.Job = object
    sys.modules["rq.job"] = fake_rq_job

from app.services.reports import (
    _build_run_artifact_paths,
    _collect_requested_fields_by_template,
    _render_composite_report_column,
    parse_report_columns_payload,
)


class ReportColumnTests(unittest.TestCase):
    def test_parse_composite_report_column(self) -> None:
        columns = parse_report_columns_payload(
            [
                {
                    "column_id": "col-1",
                    "label": "Identificador",
                    "source_type": "composite",
                    "value_type": "string",
                    "format_parts": [
                        {"part_id": "part-1", "part_type": "text", "value": "FAC-"},
                        {
                            "part_id": "part-2",
                            "part_type": "field",
                            "template_id": "template-a",
                            "field_key": "numero",
                        },
                        {"part_id": "part-3", "part_type": "space"},
                        {
                            "part_id": "part-4",
                            "part_type": "field",
                            "template_id": "template-b",
                            "field_key": "recibo",
                        },
                    ],
                }
            ]
        )

        self.assertEqual(columns[0]["source_type"], "composite")
        self.assertEqual(columns[0]["format_parts"][0]["value"], "FAC-")
        self.assertEqual(columns[0]["format_parts"][2]["value"], " ")
        self.assertEqual(columns[0]["format_parts"][3]["template_id"], "template-b")

    def test_legacy_template_field_column_still_requires_detected_templates(self) -> None:
        columns = parse_report_columns_payload(
            [
                {
                    "column_id": "col-1",
                    "label": "Razon social",
                    "source_type": "template_field",
                    "value_type": "string",
                    "template_mappings": {
                        "template-a": "razon_social",
                        "template-b": "empleado",
                    },
                }
            ],
            required_template_ids={"template-a", "template-b"},
        )

        self.assertEqual(columns[0]["source_type"], "template_field")
        self.assertEqual(columns[0]["template_mappings"]["template-a"], "razon_social")
        self.assertEqual(columns[0]["format_parts"], [])

    def test_composite_column_renders_independent_template_field_chips(self) -> None:
        column = parse_report_columns_payload(
            [
                {
                    "column_id": "col-1",
                    "label": "Nombre",
                    "source_type": "composite",
                    "value_type": "string",
                    "format_parts": [
                        {"part_type": "text", "value": "Doc "},
                        {"part_type": "field", "template_id": "template-a", "field_key": "razon_social"},
                        {"part_type": "field", "template_id": "template-b", "field_key": "empleado"},
                    ],
                }
            ]
        )[0]

        requested = _collect_requested_fields_by_template(columns=[column], template_ids={"template-a", "template-b"})
        self.assertEqual(requested["template-a"], {"razon_social"})
        self.assertEqual(requested["template-b"], {"empleado"})
        self.assertEqual(
            _render_composite_report_column(
                column=column,
                template_id="template-a",
                value_map={"razon_social": "ACME SA"},
            ),
            "Doc ACME SA",
        )
        self.assertEqual(
            _render_composite_report_column(
                column=column,
                template_id="template-b",
                value_map={"empleado": "Ana Perez"},
            ),
            "Doc Ana Perez",
        )

    def test_artifact_filename_uses_report_name(self) -> None:
        artifact_path, artifact_filename = _build_run_artifact_paths(
            tenant_id="acme",
            report_run_id="run-1",
            output_format="xlsx",
            report_name="Ventas abril",
        )

        self.assertEqual(artifact_filename, "Ventas abril.xlsx")
        self.assertEqual(artifact_path.name, "Ventas abril.xlsx")
        self.assertEqual(artifact_path.parent.name, "run-1")

    def test_artifact_filename_falls_back_to_timestamp(self) -> None:
        _artifact_path, artifact_filename = _build_run_artifact_paths(
            tenant_id="acme",
            report_run_id="run-2",
            output_format="csv",
            report_name="  ",
            generated_at=datetime(2026, 4, 24, 15, 30, 45, tzinfo=timezone.utc),
        )

        self.assertEqual(artifact_filename, "Reporte_20260424_153045.csv")


if __name__ == "__main__":
    unittest.main()
