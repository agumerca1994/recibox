from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime

from app.db.postgres import get_postgres_conn

VALID_RULE_STATUS = {"missing", "invalid", "ready"}
VALID_STORED_RULE_STATUS = {"invalid", "ready"}
VALID_RULE_NODE_TYPES = {"folder", "file"}
VALID_RULE_CONFLICT_POLICIES = {"use_existing", "create_new"}
VALID_RULE_NAME_PART_TYPES = {"field", "literal", "index"}
VALID_INDEX_KINDS = {"numeric", "alphabetic"}
VALID_INDEX_DIRECTIONS = {"incremental", "decremental"}
# Allow alphanumeric text plus common separators/symbols requested by product.
VALID_LITERAL_PATTERN = re.compile(r"^[A-Za-z0-9 #$%&/()@._,\-]+$")


@dataclass
class ClassificationRuleNamePart:
    part_id: str
    node_id: str
    part_order: int
    part_type: str
    field_key: str | None
    literal_value: str | None
    index_kind: str | None
    index_start_numeric: int | None
    index_start_alpha: str | None
    index_direction: str | None
    created_at: datetime


@dataclass
class ClassificationRuleNode:
    node_id: str
    rule_id: str
    node_order: int
    node_type: str
    conflict_policy: str | None
    name_parts: list[ClassificationRuleNamePart]
    created_at: datetime


@dataclass
class ClassificationRule:
    rule_id: str
    tenant_id: str
    template_id: str
    rule_status: str
    nodes: list[ClassificationRuleNode]
    created_at: datetime
    updated_at: datetime


@dataclass
class ClassificationRuleNamePartInput:
    part_type: str
    field_key: str | None = None
    literal_value: str | None = None
    index_kind: str | None = None
    index_start_numeric: int | None = None
    index_start_alpha: str | None = None
    index_direction: str | None = None


@dataclass
class ClassificationRuleNodeInput:
    node_type: str
    conflict_policy: str | None
    name_parts: list[ClassificationRuleNamePartInput]


@dataclass
class ClassificationRuleInput:
    nodes: list[ClassificationRuleNodeInput]


@dataclass
class DocumentFieldDefinition:
    key: str
    required: bool


def init_classification_rules_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS classification_rules (
                  rule_id TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL,
                  template_id TEXT NOT NULL UNIQUE,
                  rule_status TEXT NOT NULL DEFAULT 'invalid',
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  CONSTRAINT fk_classification_rules_template
                    FOREIGN KEY (template_id)
                    REFERENCES document_templates(template_id)
                    ON DELETE CASCADE,
                  CONSTRAINT chk_classification_rules_status
                    CHECK (rule_status IN ('invalid', 'ready'))
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_classification_rules_tenant_template
                ON classification_rules ((LOWER(tenant_id)), template_id)
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS classification_rule_nodes (
                  node_id TEXT PRIMARY KEY,
                  rule_id TEXT NOT NULL,
                  node_order INTEGER NOT NULL,
                  node_type TEXT NOT NULL,
                  conflict_policy TEXT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  CONSTRAINT fk_classification_rule_nodes_rule
                    FOREIGN KEY (rule_id)
                    REFERENCES classification_rules(rule_id)
                    ON DELETE CASCADE,
                  CONSTRAINT chk_classification_rule_nodes_type
                    CHECK (node_type IN ('folder', 'file')),
                  CONSTRAINT chk_classification_rule_nodes_policy
                    CHECK (
                      (node_type = 'folder' AND conflict_policy IN ('use_existing', 'create_new'))
                      OR
                      (node_type = 'file' AND conflict_policy IS NULL)
                    )
                )
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_rule_nodes_order
                ON classification_rule_nodes (rule_id, node_order)
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS classification_rule_name_parts (
                  part_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  part_order INTEGER NOT NULL,
                  part_type TEXT NOT NULL,
                  field_key TEXT NULL,
                  literal_value TEXT NULL,
                  index_kind TEXT NULL,
                  index_start_numeric INTEGER NULL,
                  index_start_alpha TEXT NULL,
                  index_direction TEXT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  CONSTRAINT fk_classification_rule_name_parts_node
                    FOREIGN KEY (node_id)
                    REFERENCES classification_rule_nodes(node_id)
                    ON DELETE CASCADE
                )
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_rule_name_parts_order
                ON classification_rule_name_parts (node_id, part_order)
                """
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts ADD COLUMN IF NOT EXISTS index_kind TEXT NULL"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts ADD COLUMN IF NOT EXISTS index_start_numeric INTEGER NULL"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts ADD COLUMN IF NOT EXISTS index_start_alpha TEXT NULL"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts ADD COLUMN IF NOT EXISTS index_direction TEXT NULL"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_type"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_payload"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_index_kind"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_index_direction"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_index_numeric"
            )
            cur.execute(
                "ALTER TABLE classification_rule_name_parts DROP CONSTRAINT IF EXISTS chk_classification_rule_name_parts_index_alpha"
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_type
                CHECK (part_type IN ('field', 'literal', 'index'))
                """
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_index_kind
                CHECK (
                  index_kind IS NULL
                  OR index_kind IN ('numeric', 'alphabetic')
                )
                """
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_index_direction
                CHECK (
                  index_direction IS NULL
                  OR index_direction IN ('incremental', 'decremental')
                )
                """
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_index_numeric
                CHECK (
                  index_start_numeric IS NULL
                  OR (index_start_numeric BETWEEN 0 AND 9999)
                )
                """
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_index_alpha
                CHECK (
                  index_start_alpha IS NULL
                  OR (char_length(index_start_alpha) = 1 AND upper(index_start_alpha) ~ '^[A-Z]$')
                )
                """
            )
            cur.execute(
                """
                ALTER TABLE classification_rule_name_parts
                ADD CONSTRAINT chk_classification_rule_name_parts_payload
                CHECK (
                  (
                    part_type = 'field'
                    AND field_key IS NOT NULL
                    AND literal_value IS NULL
                    AND index_kind IS NULL
                    AND index_start_numeric IS NULL
                    AND index_start_alpha IS NULL
                    AND index_direction IS NULL
                  )
                  OR
                  (
                    part_type = 'literal'
                    AND field_key IS NULL
                    AND literal_value IS NOT NULL
                    AND index_kind IS NULL
                    AND index_start_numeric IS NULL
                    AND index_start_alpha IS NULL
                    AND index_direction IS NULL
                  )
                  OR
                  (
                    part_type = 'index'
                    AND field_key IS NULL
                    AND literal_value IS NULL
                    AND index_kind IS NOT NULL
                    AND index_direction IS NOT NULL
                    AND (
                      (
                        index_kind = 'numeric'
                        AND index_start_alpha IS NULL
                        AND (
                          index_direction = 'incremental'
                          OR index_start_numeric IS NOT NULL
                        )
                      )
                      OR
                      (
                        index_kind = 'alphabetic'
                        AND index_start_numeric IS NULL
                        AND (
                          index_direction = 'incremental'
                          OR index_start_alpha IS NOT NULL
                        )
                      )
                    )
                  )
                )
                """
            )
        conn.commit()


def _normalize_text(value: str | None, field: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if required and not normalized:
        raise ValueError(f"{field} is required")
    return normalized or None


def _normalize_tenant_id(value: str | None) -> str:
    normalized = _normalize_text(value, "tenant_id", required=True)
    assert normalized is not None
    return normalized.lower()


def _normalize_rule_status(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in VALID_STORED_RULE_STATUS:
        return "invalid"
    return normalized


def _normalize_literal(value: object, field: str) -> str:
    raw = str(value or "")
    if raw == " ":
        return " "
    normalized = " ".join(raw.split())
    if not normalized:
        raise ValueError(f"{field} is required")
    if not VALID_LITERAL_PATTERN.fullmatch(normalized):
        raise ValueError(
            f"{field} only accepts alphanumeric characters, spaces, and #$%&/()@._,-"
        )
    return normalized


def _normalize_field_key(value: object, field: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field} is required")
    return normalized


def _normalize_index_kind(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in VALID_INDEX_KINDS:
        raise ValueError(f"{field} must be 'numeric' or 'alphabetic'")
    return normalized


def _normalize_index_direction(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in VALID_INDEX_DIRECTIONS:
        raise ValueError(f"{field} must be 'incremental' or 'decremental'")
    return normalized


def _normalize_index_start_numeric(value: object, field: str) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be an integer between 0 and 9999")
    if numeric < 0 or numeric > 9999:
        raise ValueError(f"{field} must be between 0 and 9999")
    return numeric


def _normalize_index_start_alpha(value: object, field: str) -> str:
    normalized = str(value or "").strip().upper()
    if len(normalized) != 1 or not ("A" <= normalized <= "Z"):
        raise ValueError(f"{field} must be a letter between A and Z")
    return normalized


def _normalize_optional_index_start_numeric(value: object, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return _normalize_index_start_numeric(value, field)


def _normalize_optional_index_start_alpha(value: object, field: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return _normalize_index_start_alpha(value, field)


def parse_classification_rule_payload(payload: dict | None) -> ClassificationRuleInput:
    if not isinstance(payload, dict):
        raise ValueError("classification_rule must be an object")

    raw_nodes = payload.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise ValueError("classification_rule.nodes must include at least one node")

    nodes: list[ClassificationRuleNodeInput] = []
    for index, raw_node in enumerate(raw_nodes):
        if not isinstance(raw_node, dict):
            raise ValueError(f"classification_rule.nodes[{index}] must be an object")

        node_type = str(raw_node.get("node_type", "")).strip().lower()
        if node_type not in VALID_RULE_NODE_TYPES:
            raise ValueError("classification_rule.nodes[%d].node_type must be 'folder' or 'file'" % index)

        if index < len(raw_nodes) - 1 and node_type != "folder":
            raise ValueError("classification_rule.nodes[%d] must be a folder node" % index)
        if index == len(raw_nodes) - 1 and node_type != "file":
            raise ValueError("classification_rule last node must be type 'file'")

        conflict_policy: str | None = None
        if node_type == "folder":
            conflict_policy = str(raw_node.get("conflict_policy", "use_existing")).strip().lower() or "use_existing"
            if conflict_policy not in VALID_RULE_CONFLICT_POLICIES:
                raise ValueError(
                    "classification_rule.nodes[%d].conflict_policy must be 'use_existing' or 'create_new'" % index
                )

        raw_parts = raw_node.get("name_parts")
        if not isinstance(raw_parts, list) or not raw_parts:
            raise ValueError("classification_rule.nodes[%d].name_parts must include at least one item" % index)

        parts: list[ClassificationRuleNamePartInput] = []
        for part_index, raw_part in enumerate(raw_parts):
            if not isinstance(raw_part, dict):
                raise ValueError(
                    "classification_rule.nodes[%d].name_parts[%d] must be an object" % (index, part_index)
                )
            part_type = str(raw_part.get("part_type", "")).strip().lower()
            if part_type not in VALID_RULE_NAME_PART_TYPES:
                raise ValueError(
                    "classification_rule.nodes[%d].name_parts[%d].part_type must be 'field', 'literal' or 'index'"
                    % (index, part_index)
                )

            if part_type == "field":
                field_key = _normalize_field_key(
                    raw_part.get("field_key"),
                    "classification_rule.nodes[%d].name_parts[%d].field_key" % (index, part_index),
                )
                parts.append(
                    ClassificationRuleNamePartInput(
                        part_type="field",
                        field_key=field_key,
                        literal_value=None,
                        index_kind=None,
                        index_start_numeric=None,
                        index_start_alpha=None,
                        index_direction=None,
                    )
                )
            elif part_type == "literal":
                literal_value = _normalize_literal(
                    raw_part.get("literal_value"),
                    "classification_rule.nodes[%d].name_parts[%d].literal_value" % (index, part_index),
                )
                parts.append(
                    ClassificationRuleNamePartInput(
                        part_type="literal",
                        field_key=None,
                        literal_value=literal_value,
                        index_kind=None,
                        index_start_numeric=None,
                        index_start_alpha=None,
                        index_direction=None,
                    )
                )
            else:
                index_kind = _normalize_index_kind(
                    raw_part.get("index_kind"),
                    "classification_rule.nodes[%d].name_parts[%d].index_kind" % (index, part_index),
                )
                index_direction = _normalize_index_direction(
                    raw_part.get("index_direction"),
                    "classification_rule.nodes[%d].name_parts[%d].index_direction" % (index, part_index),
                )
                if index_kind == "numeric":
                    if index_direction == "decremental":
                        index_start_numeric = _normalize_index_start_numeric(
                            raw_part.get("index_start_numeric"),
                            "classification_rule.nodes[%d].name_parts[%d].index_start_numeric" % (index, part_index),
                        )
                    else:
                        index_start_numeric = _normalize_optional_index_start_numeric(
                            raw_part.get("index_start_numeric"),
                            "classification_rule.nodes[%d].name_parts[%d].index_start_numeric" % (index, part_index),
                        )
                    parts.append(
                        ClassificationRuleNamePartInput(
                            part_type="index",
                            field_key=None,
                            literal_value=None,
                            index_kind="numeric",
                            index_start_numeric=index_start_numeric,
                            index_start_alpha=None,
                            index_direction=index_direction,
                        )
                    )
                else:
                    if index_direction == "decremental":
                        index_start_alpha = _normalize_index_start_alpha(
                            raw_part.get("index_start_alpha"),
                            "classification_rule.nodes[%d].name_parts[%d].index_start_alpha" % (index, part_index),
                        )
                    else:
                        index_start_alpha = _normalize_optional_index_start_alpha(
                            raw_part.get("index_start_alpha"),
                            "classification_rule.nodes[%d].name_parts[%d].index_start_alpha" % (index, part_index),
                        )
                    parts.append(
                        ClassificationRuleNamePartInput(
                            part_type="index",
                            field_key=None,
                            literal_value=None,
                            index_kind="alphabetic",
                            index_start_numeric=None,
                            index_start_alpha=index_start_alpha,
                            index_direction=index_direction,
                        )
                    )

        nodes.append(
            ClassificationRuleNodeInput(
                node_type=node_type,
                conflict_policy=conflict_policy,
                name_parts=parts,
            )
        )

    return ClassificationRuleInput(nodes=nodes)


def extract_document_field_definitions(custom_model: dict | None) -> list[DocumentFieldDefinition]:
    payload = custom_model or {}
    fields = payload.get("fields") if isinstance(payload, dict) else None
    if not isinstance(fields, list):
        return []

    definitions: list[DocumentFieldDefinition] = []
    seen_keys: set[str] = set()
    for item in fields:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()
        if not key or key in seen_keys:
            continue
        seen_keys.add(key)
        definitions.append(
            DocumentFieldDefinition(
                key=key,
                required=bool(item.get("required", False)),
            )
        )
    return definitions


def validate_classification_rule_against_fields(
    rule: ClassificationRuleInput,
    field_definitions: list[DocumentFieldDefinition],
) -> list[str]:
    available_keys = {item.key for item in field_definitions}
    if not available_keys:
        return ["Template has no document fields"]

    errors: list[str] = []
    for node_index, node in enumerate(rule.nodes):
        for part_index, part in enumerate(node.name_parts):
            if part.part_type != "field":
                continue
            field_key = str(part.field_key or "").strip()
            if field_key not in available_keys:
                errors.append(
                    "classification_rule.nodes[%d].name_parts[%d].field_key '%s' is not present in template"
                    % (node_index, part_index, field_key)
                )
    return errors


def _row_to_rule(row: tuple) -> ClassificationRule:
    return ClassificationRule(
        rule_id=row[0],
        tenant_id=row[1],
        template_id=row[2],
        rule_status=row[3],
        nodes=[],
        created_at=row[4],
        updated_at=row[5],
    )


def _row_to_node(row: tuple) -> ClassificationRuleNode:
    return ClassificationRuleNode(
        node_id=row[0],
        rule_id=row[1],
        node_order=row[2],
        node_type=row[3],
        conflict_policy=row[4],
        name_parts=[],
        created_at=row[5],
    )


def _row_to_name_part(row: tuple) -> ClassificationRuleNamePart:
    return ClassificationRuleNamePart(
        part_id=row[0],
        node_id=row[1],
        part_order=row[2],
        part_type=row[3],
        field_key=row[4],
        literal_value=row[5],
        index_kind=row[6],
        index_start_numeric=row[7],
        index_start_alpha=row[8],
        index_direction=row[9],
        created_at=row[10],
    )


def _load_rule_nodes(rule_ids: list[str]) -> dict[str, list[ClassificationRuleNode]]:
    if not rule_ids:
        return {}

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT node_id, rule_id, node_order, node_type, conflict_policy, created_at
                FROM classification_rule_nodes
                WHERE rule_id = ANY(%s::text[])
                ORDER BY node_order ASC
                """,
                (rule_ids,),
            )
            node_rows = cur.fetchall()

    nodes_by_rule: dict[str, list[ClassificationRuleNode]] = {}
    for row in node_rows:
        node = _row_to_node(row)
        nodes_by_rule.setdefault(node.rule_id, []).append(node)
    return nodes_by_rule


def _load_name_parts(node_ids: list[str]) -> dict[str, list[ClassificationRuleNamePart]]:
    if not node_ids:
        return {}

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT part_id, node_id, part_order, part_type, field_key, literal_value,
                       index_kind, index_start_numeric, index_start_alpha, index_direction, created_at
                FROM classification_rule_name_parts
                WHERE node_id = ANY(%s::text[])
                ORDER BY part_order ASC
                """,
                (node_ids,),
            )
            part_rows = cur.fetchall()

    parts_by_node: dict[str, list[ClassificationRuleNamePart]] = {}
    for row in part_rows:
        part = _row_to_name_part(row)
        parts_by_node.setdefault(part.node_id, []).append(part)
    return parts_by_node


def _hydrate_rules(rules: list[ClassificationRule]) -> list[ClassificationRule]:
    if not rules:
        return []

    rule_ids = [rule.rule_id for rule in rules]
    nodes_by_rule = _load_rule_nodes(rule_ids)

    node_ids: list[str] = []
    for nodes in nodes_by_rule.values():
        node_ids.extend(node.node_id for node in nodes)
    parts_by_node = _load_name_parts(node_ids)

    hydrated: list[ClassificationRule] = []
    for rule in rules:
        nodes = nodes_by_rule.get(rule.rule_id, [])
        for node in nodes:
            node.name_parts = parts_by_node.get(node.node_id, [])
        rule.nodes = nodes
        hydrated.append(rule)
    return hydrated


def get_classification_rule(*, tenant_id: str, template_id: str) -> ClassificationRule | None:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    assert normalized_template_id is not None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rule_id, tenant_id, template_id, rule_status, created_at, updated_at
                FROM classification_rules
                WHERE LOWER(tenant_id) = %s AND template_id = %s
                """,
                (normalized_tenant, normalized_template_id),
            )
            row = cur.fetchone()

    if not row:
        return None

    rules = _hydrate_rules([_row_to_rule(row)])
    return rules[0] if rules else None


def list_classification_rules_for_templates(*, tenant_id: str, template_ids: list[str]) -> dict[str, ClassificationRule]:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_ids = [
        template_id
        for template_id in (_normalize_text(item, "template_id") for item in template_ids)
        if template_id is not None
    ]
    if not normalized_template_ids:
        return {}

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rule_id, tenant_id, template_id, rule_status, created_at, updated_at
                FROM classification_rules
                WHERE LOWER(tenant_id) = %s
                  AND template_id = ANY(%s::text[])
                ORDER BY updated_at DESC
                """,
                (normalized_tenant, normalized_template_ids),
            )
            rows = cur.fetchall()

    rules = _hydrate_rules([_row_to_rule(row) for row in rows])
    return {rule.template_id: rule for rule in rules}


def _serialize_rule_input(
    rule: ClassificationRuleInput,
) -> list[
    tuple[
        str,
        str | None,
        list[tuple[str, str | None, str | None, str | None, int | None, str | None, str | None]],
    ]
]:
    serialized: list[
        tuple[
            str,
            str | None,
            list[tuple[str, str | None, str | None, str | None, int | None, str | None, str | None]],
        ]
    ] = []
    for node in rule.nodes:
        serialized_parts: list[tuple[str, str | None, str | None, str | None, int | None, str | None, str | None]] = []
        for part in node.name_parts:
            serialized_parts.append(
                (
                    part.part_type,
                    part.field_key,
                    part.literal_value,
                    part.index_kind,
                    part.index_start_numeric,
                    part.index_start_alpha,
                    part.index_direction,
                )
            )
        serialized.append((node.node_type, node.conflict_policy, serialized_parts))
    return serialized


def upsert_classification_rule(
    *,
    tenant_id: str,
    template_id: str,
    rule: ClassificationRuleInput,
    rule_status: str,
) -> ClassificationRule:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    assert normalized_template_id is not None
    normalized_status = _normalize_rule_status(rule_status)
    serialized_nodes = _serialize_rule_input(rule)

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO classification_rules (rule_id, tenant_id, template_id, rule_status)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (template_id)
                DO UPDATE SET
                  tenant_id = EXCLUDED.tenant_id,
                  rule_status = EXCLUDED.rule_status,
                  updated_at = NOW()
                RETURNING rule_id
                """,
                (str(uuid.uuid4()), normalized_tenant, normalized_template_id, normalized_status),
            )
            row = cur.fetchone()
            if not row:
                raise RuntimeError("Could not create or update classification rule")
            rule_id = str(row[0])

            cur.execute(
                "DELETE FROM classification_rule_nodes WHERE rule_id = %s",
                (rule_id,),
            )

            for node_index, (node_type, conflict_policy, parts) in enumerate(serialized_nodes, start=1):
                node_id = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO classification_rule_nodes (
                      node_id, rule_id, node_order, node_type, conflict_policy
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (node_id, rule_id, node_index, node_type, conflict_policy),
                )

                for (
                    part_index,
                    (
                        part_type,
                        field_key,
                        literal_value,
                        index_kind,
                        index_start_numeric,
                        index_start_alpha,
                        index_direction,
                    ),
                ) in enumerate(parts, start=1):
                    cur.execute(
                        """
                        INSERT INTO classification_rule_name_parts (
                          part_id, node_id, part_order, part_type, field_key, literal_value,
                          index_kind, index_start_numeric, index_start_alpha, index_direction
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            str(uuid.uuid4()),
                            node_id,
                            part_index,
                            part_type,
                            field_key,
                            literal_value,
                            index_kind,
                            index_start_numeric,
                            index_start_alpha,
                            index_direction,
                        ),
                    )
        conn.commit()

    saved = get_classification_rule(tenant_id=normalized_tenant, template_id=normalized_template_id)
    if not saved:
        raise RuntimeError("Classification rule was not persisted")
    return saved


def delete_classification_rule(*, tenant_id: str, template_id: str) -> bool:
    normalized_tenant = _normalize_tenant_id(tenant_id)
    normalized_template_id = _normalize_text(template_id, "template_id", required=True)
    assert normalized_template_id is not None

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM classification_rules
                WHERE LOWER(tenant_id) = %s AND template_id = %s
                """,
                (normalized_tenant, normalized_template_id),
            )
            deleted = cur.rowcount > 0
        conn.commit()
    return deleted


def evaluate_classification_rule_status(
    *,
    rule: ClassificationRule | None,
    field_definitions: list[DocumentFieldDefinition],
) -> tuple[str, list[str]]:
    if not rule:
        return "missing", []

    parsed_rule = ClassificationRuleInput(
        nodes=[
            ClassificationRuleNodeInput(
                node_type=node.node_type,
                conflict_policy=node.conflict_policy,
                name_parts=[
                    ClassificationRuleNamePartInput(
                        part_type=part.part_type,
                        field_key=part.field_key,
                        literal_value=part.literal_value,
                        index_kind=part.index_kind,
                        index_start_numeric=part.index_start_numeric,
                        index_start_alpha=part.index_start_alpha,
                        index_direction=part.index_direction,
                    )
                    for part in node.name_parts
                ],
            )
            for node in rule.nodes
        ]
    )

    errors = validate_classification_rule_against_fields(parsed_rule, field_definitions)
    if errors:
        return "invalid", errors
    return "ready", []


def serialize_classification_rule(rule: ClassificationRule | None) -> dict | None:
    if not rule:
        return None

    return {
        "rule_id": rule.rule_id,
        "template_id": rule.template_id,
        "tenant_id": rule.tenant_id,
        "rule_status": rule.rule_status,
        "nodes": [
            {
                "node_id": node.node_id,
                "node_order": node.node_order,
                "node_type": node.node_type,
                "conflict_policy": node.conflict_policy,
                "name_parts": [
                    {
                        "part_id": part.part_id,
                        "part_order": part.part_order,
                        "part_type": part.part_type,
                        "field_key": part.field_key,
                        "literal_value": part.literal_value,
                        "index_kind": part.index_kind,
                        "index_start_numeric": part.index_start_numeric,
                        "index_start_alpha": part.index_start_alpha,
                        "index_direction": part.index_direction,
                    }
                    for part in node.name_parts
                ],
            }
            for node in rule.nodes
        ],
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }
