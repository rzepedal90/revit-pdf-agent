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

Additional top-level field `datum_table` (object; see [Datum table](#datum-table) and [elevation-datum-table.md](elevation-datum-table.md)): **required and validated in `PLAN`/`EXECUTE`**; in `ANALYZE` a missing or incomplete table only prints `WARNING:` lines on stderr.

## Target

Require `rvt_path`, `rvt_title`, `revit_version`, `mcp_version`, `active_view`, `unit_system`, `phase`, `workset`, `design_option`. Values may be `null` in `ANALYZE` only when a clarification requests them.

## Sources

Each: `source_id`, `role` (`primary`|`supplementary`), `path`, `sha256`, `sheet`, `revision`, `units`, `registered_in_revit`, `positional_authority`, `drawing_regions`, plus `human_aligned`, `human_scaled`, `pinned_expected`, `immutable`. Exactly one primary; it must have all four flags true, `registered_in_revit` true and `positional_authority` true. A supplementary source that is not registered must have `positional_authority: false`.

## Scope

`categories` (non-empty; keys from the input contract), `rebar: false`, `excluded_categories`.

## Coordinate basis

Manifest coordinates are drawing/grid-relative integer mm. `coordinate_basis.transform_to_model = {"originMm": {"x": int, "y": int}, "rotationDeg": number}` maps them to model coordinates (required in `PLAN`/`EXECUTE`); the compiler passes it unchanged as `build_elements.transform`.

When `grids` is in scope require `origin`, `positive_x`, `positive_y`, `coordinate_policy`, `anchors` (each with name plus ElementId/UniqueId when known) and a `registration_checks` list.

## Optional documentation

`documentation.dimensions.enabled` is a boolean. When true also `groups` (from `grid_chain, overall, element_size, element_offset, support_chain, oblique_chain`), non-empty `target_views`, and `intent` (`reproduce_source|clean_documentation|both`). Enabling dimensions does not add them to `scope.categories`; in this MCP the dimension phase is analysis-only.

## Types and elements

Every row: unique `source_key` (across both lists), `status` (`resolved|blocked|excluded`), `category` (in `scope.categories`), non-empty `evidence`.

Type rows add `action` (`reuse|duplicate|load` when resolved; `blocked` when blocked/excluded), family/type identity, dimensions, material, insertion plane, validation checks. For `duplicate`, name the closest validated base type.

Element rows add `type_key`, geometry in integer mm, Z constraints (tie to `datum_table` rows), host/support relationships, phase/workset, and `execution_action`. `blocked`/`excluded` rows must use `execution_action: "none"`. Every physical element (anchor stem, pedestal, muerto, FV pad, beam link, each abutting footing component) has its own row.

Stable keys look like `1725-S401/F3/017`. Never use ElementIds as source keys; record ElementId and UniqueId after commit as runtime results.

## Datum table

`datum_table` is an object (required in `PLAN`/`EXECUTE`):

```json
{"npt_mm": 0, "sf_mm": -2650, "og_mm": -300, "top_of_footing_mm": -1650,
 "rules": {"footing": {"top": "...", "bottom": "..."}, "column": {}, "beam": {}, "wall": {}},
 "rows": [{"name": "N.P.T.", "value_mm": 0, "level_ref": "NPT", "evidence": "S301 sec A", "status": "resolved"}]}
```

`npt_mm` and `sf_mm` are integers (mm); `og_mm` and `top_of_footing_mm` are optional integers. `rules.<footing|column|beam|wall>` each need non-blank `top` and `bottom` (a text rule or datum reference explaining how that category's top/bottom Z is derived; it justifies the rows' `z_constraints`). `rows` is the evidence trail: recommended, not validated.

## Element and type geometry conventions (normative; maps 1:1 onto `build_elements`)

All lengths are **integer mm**; `rotation_deg` is a number; level fields are Revit level names. Resolved element rows in `PLAN`/`EXECUTE` must use `execution_action: "create"`.

| Category (kind) | `geometry_mm` | `z_constraints` | build_elements fields |
|---|---|---|---|
| `structural_foundations` (footing) | `{x, y, rotation_deg}` | `{level, offset_mm}` | `point, rotationDeg, level, offsetMm` |
| `structural_columns` (column) | `{x, y, rotation_deg}` | `{base_level, base_offset_mm, top_level, top_offset_mm}` | `point, rotationDeg, baseLevel, baseOffsetMm, topLevel, topOffsetMm` |
| `structural_framing` (beam) | `{start:[x,y], end:[x,y]}` | `{level, start_offset_mm, end_offset_mm, z_justification}` (`top`, `center` or `bottom`) | `start, end, level, startOffsetMm, endOffsetMm, zJustification` |
| `structural_walls` (wall) | `{start:[x,y], end:[x,y]}` | `{base_level, base_offset_mm}` plus exactly one of `{top_level, top_offset_mm}` or `{height_mm}` | `start, end, baseLevel, baseOffsetMm`, then `topLevel+topOffsetMm` or `heightMm`; `structural` from row `structural` (default true); `locationLine` always `center` |
| `grids` (grid) | `{start:[x,y], end:[x,y]}` plus row `name` | none | `name, start, end` |

Optional row fields: `group` (string), `structural_usage` (beam), `structural` (wall), `parameters` (`[{name,value,units}]`, passed through).

**Type linkage.** Non-grid rows carry `type_key` naming a resolved `type_manifest` row. Resolved type rows must have `family`, `type`, `dimensions_mm` (non-empty object of integer mm), `material` and `action` (`reuse|duplicate|load`). The compiler sends `familyName = family`, `typeName = type` (typeIds are unknown until runtime).

**Combined / L-shaped footings.** Model each rectangular component as its own abutting row (own `source_key`; own `type_key` where sizes differ) and give all components the same `group` (e.g. `"F4a"`). Never substitute a bounding box.

## Clarifications

Each: `id` (unique), `topic`, `status` (`open|answered`), `affected_source_keys`, `evidence`, `proposal`, `question`.

## Execution policy

`commit_authorized`, `expected_revit_changes`, `primary_pdf_immutable: true`, `anchor_grids_immutable: true`, `allow_delete_existing: false`, `allow_modify_existing_types: false`. `ANALYZE` requires `commit_authorized: false` and `expected_revit_changes: 0`; `EXECUTE` requires `manifest_frozen: true` and `commit_authorized: true`.

## Acceptance tests

- `expected_counts`: object `{category: integer}` of resolved element rows per category. **Validator rule:** when present and non-empty, the number of `resolved` element rows per category must equal it exactly (categories with resolved rows but not listed count as expected 0). An absent or empty object disables the rule. Cross-check these numbers against PDF label counts.
- mm tolerances for dimensioned values; overlay tolerance separately (diagnostic only); duplicate policy; warning-delta policy; blocked/excluded source keys.

## Optional frozen flow manifest

When a new category or custom stage is needed, add `flow_manifest` (`schema_version: 1`, `stages[]` with `id` starting `stage:`, `label`, `source`, `categories`, `depends_on` naming only earlier stages; `qa.enabled` boolean). Categories owned by stages become allowed categories; duplicate ownership, unknown dependencies and forward dependencies fail validation.
