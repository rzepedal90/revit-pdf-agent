<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Manifest Schema

One JSON object with `schema_version` `"1.0"`. Validate with `node scripts/validate_manifest.mjs <manifest.json>`.

## Required top-level fields

```json
{
  "schema_version": "1.0",
  "mode": "ANALYZE",
  "manifest_frozen": false,
  "target": {},
  "sources": [],
  "scope": {},
  "documentation": {"dimensions": {"enabled": false}},
  "coordinate_basis": {},
  "levels": [],
  "type_manifest": [],
  "element_manifest": [],
  "clarifications": [],
  "execution_policy": {},
  "acceptance_tests": {}
}
```

Recommended extra top-level field (not enforced by the validator): `datum_table` - array of `{name, value_mm, level_ref, evidence, status}` (see [elevation-datum-table.md](elevation-datum-table.md)).

## Target

Require `rvt_path`, `rvt_title`, `revit_version`, `mcp_version`, `active_view`, `unit_system`, `phase`, `workset`, `design_option`. Values may be `null` in `ANALYZE` only when a clarification requests them.

## Sources

Each: `source_id`, `role` (`primary`|`supplementary`), `path`, `sha256`, `sheet`, `revision`, `units`, `registered_in_revit`, `positional_authority`, `drawing_regions`, plus `human_aligned`, `human_scaled`, `pinned_expected`, `immutable`. Exactly one primary; it must have all four flags true, `registered_in_revit` true and `positional_authority` true. A supplementary source that is not registered must have `positional_authority: false`.

## Scope

`categories` (non-empty; keys from the input contract), `rebar: false`, `excluded_categories`.

## Coordinate basis

When `grids` is in scope require `origin`, `positive_x`, `positive_y`, `coordinate_policy`, `anchors` (each with name plus ElementId/UniqueId when known) and a `registration_checks` list.

## Optional documentation

`documentation.dimensions.enabled` is a boolean. When true also `groups` (from `grid_chain, overall, element_size, element_offset, support_chain, oblique_chain`), non-empty `target_views`, and `intent` (`reproduce_source|clean_documentation|both`). Enabling dimensions does not add them to `scope.categories`; in this MCP the dimension phase is analysis-only.

## Types and elements

Every row: unique `source_key` (across both lists), `status` (`resolved|blocked|excluded`), `category` (in `scope.categories`), non-empty `evidence`.

Type rows add `action` (`reuse|duplicate|load` when resolved; `blocked` when blocked/excluded), family/type identity, dimensions, material, insertion plane, validation checks. For `duplicate`, name the closest validated base type.

Element rows add `type_key`, geometry in integer mm, Z constraints (tie to `datum_table` rows), host/support relationships, phase/workset, and `execution_action`. `blocked`/`excluded` rows must use `execution_action: "none"`. Every physical element (anchor stem, pedestal, muerto, FV pad, beam link, each abutting footing component) has its own row.

Stable keys look like `1725-S401/F3/017`. Never use ElementIds as source keys; record ElementId and UniqueId after commit as runtime results.

## Clarifications

Each: `id` (unique), `topic`, `status` (`open|answered`), `affected_source_keys`, `evidence`, `proposal`, `question`.

## Execution policy

`commit_authorized`, `expected_revit_changes`, `primary_pdf_immutable: true`, `anchor_grids_immutable: true`, `allow_delete_existing: false`, `allow_modify_existing_types: false`. `ANALYZE` requires `commit_authorized: false` and `expected_revit_changes: 0`; `EXECUTE` requires `manifest_frozen: true` and `commit_authorized: true`.

## Acceptance tests

- `expected_counts`: object `{category: integer}` of resolved element rows per category. **Validator rule:** when present and non-empty, the number of `resolved` element rows per category must equal it exactly (categories with resolved rows but not listed count as expected 0). An absent or empty object disables the rule. Cross-check these numbers against PDF label counts.
- mm tolerances for dimensioned values; overlay tolerance separately (diagnostic only); duplicate policy; warning-delta policy; blocked/excluded source keys.

## Optional frozen flow manifest

When a new category or custom stage is needed, add `flow_manifest` (`schema_version: 1`, `stages[]` with `id` starting `stage:`, `label`, `source`, `categories`, `depends_on` naming only earlier stages; `qa.enabled` boolean). Categories owned by stages become allowed categories; duplicate ownership, unknown dependencies and forward dependencies fail validation.
