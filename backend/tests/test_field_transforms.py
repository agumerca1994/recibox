from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.templates.field_transforms import (
    FieldTransformGroupInput,
    FieldTransformStepInput,
    apply_field_transforms_to_value_map,
    apply_transform_pipeline,
)


def _step(operation: str, **kwargs) -> FieldTransformStepInput:
    return FieldTransformStepInput(operation=operation, **kwargs)


class FieldTransformTests(unittest.TestCase):
    def test_trim_replace_case_pipeline(self) -> None:
        steps = [
            _step("trim"),
            _step("replace", param_from="-", param_to=" "),
            _step("case", param_case="title"),
        ]
        result, snapshots = apply_transform_pipeline("  mes-2026  ", steps, field_key="periodo")
        self.assertEqual(result, "Mes 2026")
        self.assertEqual(snapshots, ["  mes-2026  ", "mes-2026", "mes 2026", "Mes 2026"])

    def test_remove_chars(self) -> None:
        steps = [_step("remove_chars", param_chars=".#")]
        result, _ = apply_transform_pipeline("12.345#67", steps, field_key="importe")
        self.assertEqual(result, "1234567")

    def test_split_is_one_based(self) -> None:
        steps = [_step("split", param_delimiter="/", param_index=2)]
        result, _ = apply_transform_pipeline("03/2026", steps, field_key="periodo")
        self.assertEqual(result, "2026")

    def test_split_out_of_range_fails(self) -> None:
        steps = [_step("split", param_delimiter="/", param_index=3)]
        with self.assertRaises(ValueError):
            apply_transform_pipeline("03/2026", steps, field_key="periodo")

    def test_date_format_common_numeric(self) -> None:
        steps = [_step("date_format", param_date_output="MM/YYYY")]
        result, _ = apply_transform_pipeline("11/03/2026", steps, field_key="fecha")
        self.assertEqual(result, "03/2026")

    def test_date_format_spanish_month_text(self) -> None:
        steps_abbr = [_step("date_format", param_date_output="MMM")]
        steps_full = [_step("date_format", param_date_output="MMMM")]
        result_abbr, _ = apply_transform_pipeline("ene 2026", steps_abbr, field_key="fecha")
        result_full, _ = apply_transform_pipeline("Enero 2026", steps_full, field_key="fecha")
        self.assertEqual(result_abbr, "ENE")
        self.assertEqual(result_full, "ENERO")

    def test_date_format_missing_component_fails(self) -> None:
        steps = [_step("date_format", param_date_output="DD")]
        with self.assertRaises(ValueError):
            apply_transform_pipeline("03/2026", steps, field_key="fecha")

    def test_apply_on_value_map(self) -> None:
        groups = [
            FieldTransformGroupInput(
                field_key="periodo",
                steps=[_step("split", param_delimiter="/", param_index=2)],
            )
        ]
        updated, snapshots = apply_field_transforms_to_value_map(
            value_map={"periodo": "03/2026", "empleado": "Ana"},
            groups=groups,
        )
        self.assertEqual(updated["periodo"], "2026")
        self.assertEqual(updated["empleado"], "Ana")
        self.assertEqual(snapshots["periodo"], ["03/2026", "2026"])


if __name__ == "__main__":
    unittest.main()
