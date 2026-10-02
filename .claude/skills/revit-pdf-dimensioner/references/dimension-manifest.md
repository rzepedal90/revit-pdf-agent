<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
> Execution not yet supported in this MCP (no stable-reference resolver); analysis/manifest only.

# Dimension Manifest

Use one JSON object with `schema_version: "1.0"`.

## Required structure

```json
{
  "schema_version": "1.0",
  "mode": "ANALYZE",
  "manifest_frozen": false,
  "parent_model_manifest_sha256": "<canonical SHA-256>",
  "target": {
    "rvt_path": "<absolute path>",
    "rvt_title": "<title>",
    "revit_version": "2027",
    "mcp_version": "<version>"
  },
  "source_ids": ["<primary source id>"],
  "scope": {
    "enabled": true,
    "groups": ["grid_chain"],
    "inventory_complete": false,
    "group_inventory": {
      "grid_chain": {"total": 0, "resolved": 0, "blocked": 0, "excluded": 0}
    },
    "target_view_unique_ids": ["<UniqueId>"],
    "intent": "reproduce_source"
  },
  "dimension_type": {
    "unique_id": "<UniqueId>",
    "name": "<type name>",
    "verified": true
  },
  "layout_policy": {
    "offset_units": "paper_mm",
    "local_lane_mm": 8,
    "chain_lane_mm": 14,
    "overall_lane_mm": 20
  },
  "dimensions": [],
  "clarifications": [],
  "execution_policy": {
    "commit_authorized": false,
    "expected_revit_changes": 0,
    "primary_pdf_immutable": true,
    "allow_move_model_elements": false,
    "allow_value_override": false
  },
  "acceptance_tests": {}
}
```

`intent` is `reproduce_source`, `clean_documentation`, or `both`. Allowed groups are `grid_chain`, `overall`, `element_size`, `element_offset`, `support_chain`, and `oblique_chain`.

For `EXECUTE`, `inventory_complete` must be true. `group_inventory` must contain every selected group and its totals must exactly reconcile with individual dimension rows. Preserve the user-approved group list across staged payloads; batches may select a subset of resolved rows, but must not rewrite the manifest scope to that subset.

## Dimension rows

Each row requires a unique stable `source_key`; `status` (`resolved`, `blocked`, or `excluded`); `role`; `view_unique_id`; `dimension_type_unique_id`; ordered `references`; model-space `line` endpoints in millimetres; `side` and `lane`; `expected_values_mm` and `tolerance_mm`; non-empty `evidence`; `canonical_signature`; and `execution_action`.

Each resolved reference contains `element_unique_id`, `semantic_selector`, and `stable_representation`. Blocked and excluded rows use `execution_action: "none"`. A resolved row may use `create` or `skip`. Never store or request a value override.

After commit, record runtime ElementId, UniqueId, resolved canonical signature, actual segment values, warnings, and readback status outside the frozen intent fields.

Clarifications identify affected source keys, evidence, proposal, and one answerable question. Acceptance tests state expected counts by view/role, numerical tolerance, duplicate policy, warning policy, stable-reference reopen check, and permitted human-cleanup exceptions.
