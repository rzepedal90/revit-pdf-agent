<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Revit MCP Execution Policy

Read this only for `PLAN` or `EXECUTE`.

## Runtime guard

Before any mutation, use read-only tools to confirm the exact RVT path/title, Revit and MCP versions, active view, units, levels, phase, workset, design option, primary PDF identity/state, anchor grids, loaded families/types, materials and existing generated source keys. Abort if the document changes during the run. List the live MCP tools first: a tool seen in another version or in this document's "planned" column is not evidence it is available now.

## Tool mapping (our MCP) and fallbacks

"Planned" tools are being added in parallel; use them when the live tool list shows them, otherwise use the fallback. A fallback is always explicit, reviewed C# through `send_code_to_revit` (injected variable `document`; `transactionMode: auto` wraps in one transaction, `none` when the snippet manages its own transactions/groups). Convert mm to feet inside C#. If no fallback is acceptable, the step is **blocked**.

| Need | Use | Fallback / status |
|---|---|---|
| Spatial transform (PDF placement, grid curves, pinned, view frame) | `get_spatial_reference` (planned) | read-only `send_code_to_revit`; else spatial steps blocked |
| View/ground truth images | `get_view_image` (planned), `get_current_view_info` | none needed for numerical QA |
| Read elements / parameters | `get_elements_info` (planned), `get_current_view_elements`, `ai_element_filter`, `get_selected_elements` | `send_code_to_revit` read-only |
| Filtered queries by parameter | `find_elements`, `query_where` (planned) | `ai_element_filter` + C# |
| Loaded family types | `get_available_family_types` | - |
| Grids / levels | `create_grid`, `create_level` (mm) | - |
| Footings, columns, pedestals, stems, pads (point-based) | `create_point_based_element` (mm) | - |
| Beams, walls (line-based) | `create_line_based_element` (mm) | - |
| Slabs (surface) | `create_surface_based_element` | blocked until thickness/boundary confirmed |
| Source key tagging / lookup | `set_source_key`, `find_by_source_key` (planned) | external source-key to UniqueId map file + exact geometry/type match; optionally Comments via C# |
| Set parameters (offsets, tops, materials) | `set_parameter`, `set_parameter_batch` (planned) | `operate_element` where it applies; else C# |
| Duplicate a type | `duplicate_family_type` (planned) | C# `FamilySymbol.Duplicate(name)` then set parameters |
| Change an instance's type | `change_element_type` (planned) | C# `element.ChangeTypeId` |
| Dry-run / batched atomic stages | `batch` with `dryRun` (later) | C# in `transactionMode: none` using a `TransactionGroup` that is `RollBack()`ed for preview; or no MCP dry-run: review payloads offline and commit one element first |
| Rotation of placed instances | - | `create_point_based_element` rotation if supported; else C# `ElementTransformUtils.RotateElement` (separate step, record it) |
| Save / export / reopen | - | C# `document.Save()`; do not take screen control |
| Dimensions | not supported (no stable-reference resolver) | blocked |

Never mutate with unreviewed C#. Show the snippet in the plan, run it on one element, read the result back, then proceed.

## Immutable content

Never move, rotate, scale, unpin, replace, permanently hide or delete the primary PDF. Never move/rename/delete human anchors or levels. Never delete existing model elements or modify existing family types unless the user gives separate explicit authorization. Rebar and reinforcement creation are prohibited.

## Type generation

Decision order: (1) reuse an exact verified match; (2) duplicate the closest validated parametric loadable-family type and set accessible parameters; (3) load a vetted RFA supplied/approved by the user; (4) block the type. Never reuse a mismatched type. Do not create in-place families. Treat system-family duplication (wall types) as unavailable unless the live tools explicitly support it.

Use source-scoped type names. Read every created type back and verify category, family, dimensions, material, reference plane and behavior before creating dependent instances.

## Payload and transaction rules

Execute dependency stages separately: types, grids, foundations, columns/pedestals/stems, framing, walls/floors/openings, metadata, QA. For each mutating stage: build and freeze the exact payload, hash its canonical form, preview when a dry-run exists, review, commit the identical payload, stop on the first failure or mismatch, query committed objects back and record ElementId + UniqueId. Dry-run IDs are temporary and never reused.

## Idempotency

Use stable source keys. Prefer `set_source_key`/`find_by_source_key` when available; otherwise keep an external source-key to UniqueId map and verified geometric/type matching. A rerun updates or skips a unique match; stop on zero/multiple ambiguous matches rather than creating a duplicate.

## QA

Numerical first: counts per category vs `expected_counts`, coordinates, dimensions, elevations vs the datum table, types, rotations, materials, joins/supports, duplicates, exclusions, warning deltas. The PDF overlay (view image, PDF visible) is diagnostic, with a looser tolerance than dimensioned geometry; hide the PDF for numerical checks only through a reversible view-only operation.
