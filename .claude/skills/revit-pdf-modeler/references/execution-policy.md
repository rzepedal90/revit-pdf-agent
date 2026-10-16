<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Revit MCP Execution Policy

Read this only for `PLAN` or `EXECUTE`.

## Runtime guard

Before any mutation, use read-only tools to confirm the exact RVT path/title, Revit and MCP versions, active view, units, levels, phase, workset, design option, primary PDF identity/state, anchor grids, loaded families/types, materials and existing generated source keys. Abort if the document changes during the run. List the live MCP tools first: a tool seen in another version or in this document's "planned" column is not evidence it is available now.

## Tool mapping (our MCP) and fallbacks

All tools below exist in this repository's MCP server. Still list the live tools first; a tool missing from the live list (older plugin build) falls back to reviewed C# through `send_code_to_revit` (injected variable `document`; `transactionMode: auto` wraps in one transaction, `none` when the snippet manages its own transactions/groups; convert mm to feet inside C#). If no fallback is acceptable, the step is **blocked**.

| Need | Use | Fallback |
|---|---|---|
| Spatial transform (PDF placement, grid curves, pinned, view frame) | `get_spatial_reference` | read-only `send_code_to_revit`; else blocked |
| View / ground-truth images | `get_view_image`, `get_current_view_info` | none needed for numerical QA |
| Read elements / parameters | `get_elements_info` (batched), `get_current_view_elements`, `ai_element_filter`, `get_selected_elements` | read-only C# |
| Filtered queries | `find_elements`, `query_where` | `ai_element_filter` + C# |
| Loaded family types | `get_available_family_types` | - |
| **Bulk creation from a frozen manifest** (grids, footings, columns, beams, walls incl. architectural `structural:false`, floors; dry-run, upsert by source key) | **`build_elements`** via `scripts/compile_build_payload.mjs` + `scripts/revit_rpc.mjs` | `create_grid`, `create_point_based_element`, `create_line_based_element` one element at a time |
| Aligned CAD geometry (layers, per-layer segments/polylines in model mm) | `get_cad_geometry` (`layers` / `geometry`, layer filter, `outFile`) | read-only `send_code_to_revit` over the ImportInstance geometry; else blocked |
| Levels (only when `levels` is in scope and the level has `action: "create"`) | `create_level` with the `data` of `levels_to_create.json` (not part of `build_elements`) | - |
| Floors / slabs | `build_elements` kind `floor` (`level`, `offsetMm`, `boundary` loops, `structural`) | `create_surface_based_element`; blocked until thickness/boundary confirmed |
| Source key tagging / lookup | `set_source_key`, `find_by_source_key` | external key-to-UniqueId map + exact geometry/type match |
| Set parameters (offsets, tops, materials) | `set_parameter`, `set_parameter_batch` (verified writes) | `operate_element` where it applies; else C# |
| Duplicate a type | `duplicate_family_type` | C# `FamilySymbol.Duplicate(name)` then set parameters |
| Change an instance's type | `change_element_type` | C# `element.ChangeTypeId` |
| Save / export / reopen | - | C# `document.Save()`; no screen control |
| Dimensions | not supported (no stable-reference resolver) | blocked |

Never mutate with unreviewed C#. Show the snippet in the plan, run it on one element, read the result back, then proceed.

## EXECUTE flow (script path, token-efficient)

Payloads and readbacks stay on disk and never pass through the model context; only bounded summaries (counts, warnings, first errors) are printed. Paths are relative to `.claude/skills/revit-pdf-modeler/scripts/`.

1. Validate: `node validate_manifest.mjs manifest.json` (must print `VALID`; mode EXECUTE, `manifest_frozen` true).
2. Compile: `node compile_build_payload.mjs manifest.json --out-dir out/payloads`. Produces one `build_payload_NNN_<stage>.json` per stage chunk (grids, footings, columns, beams, walls, floors; at most 500 elements each, ordered by source key), `compile_summary.json` and the canonical `manifestHash`. Blocked/excluded rows are skipped and listed. When levels have `action: "create"` it also writes `levels_to_create.json` (`{tool: "create_level", data: [{name, elevation}]}`, ascending elevation): create those levels first (the human authorized them by putting `levels` in scope), read them back, and only then run the element stages that reference them. Existing levels are never touched.

   **CAD-aligned runs**: coordinates already come from the aligned CAD and the snapped grid intersections (frozen in the manifest); do not re-read the CAD during EXECUTE, and do not move the DWG ImportInstance.
3. Types first: resolve every `familyName`/`typeName` against `get_available_family_types`; create missing ones with `duplicate_family_type` (see Type generation). Never proceed with a missing type.
4. Dry run each payload in order: `node revit_rpc.mjs build_elements out/payloads/build_payload_001_grid.json --allow-write --out out/dry_001.json`. The client refuses a payload that is not `dryRun:true`. Optional `--chunk-bytes N` splits `elements` into sequential requests whose JSON-RPC envelope is below N bytes (the plugin accepts large requests, so this is off by default; use it for very large payloads or slow commits). Counts, warnings, errors and items are aggregated, the run stops at the first failed chunk (exit 1, `stoppedAtChunk` in the summary) and `--out` gets the full aggregate plus a per-chunk list.

   **Run options.** `execution_policy.build_options` (optional object) `{readbackToleranceMm?: number 0..100, wallJoins?: "allow"|"disallow", suppressWarningDialogs?: boolean}` is copied by `compile_build_payload.mjs` into every payload as top-level `build_elements` parameters (omitted keys keep the tool defaults: 0.5 mm, allow, true). Use `wallJoins: "disallow"` when walls must keep their exact requested ends and a larger `readbackToleranceMm` only with a stated reason; they are part of the frozen manifest, so they are approved with it.
5. Review warnings/errors from the printed summary (`node json_summary.mjs out/dry_001.json warnings 10` for detail). Stop on any error or unexpected warning; fix the manifest, not the payload.
6. Commit the identical payload: same command plus `--commit` (sends `dryRun:false`, nothing else changes; `manifestHash` is unchanged). Stop at the first failed chunk.
7. QA: read every element back with `node revit_rpc.mjs readback <SHEET/> [<prefix>...] --out out/qa` (pages `find_by_source_key` with `limit`/`offset` until `hasMore` is false, fetches `get_elements_info` in batches of 150, writes `sources.json` and `readback.json`) and run `node qa_model.mjs --manifest manifest.json --readback out/qa/readback.json --sources out/qa/sources.json` for counts, coordinates, elevations vs the datum table, types and rotations. Overlay images are diagnostic only.

Reruns are safe: `mode: "upsert"` updates or skips matched source keys.

## Immutable content

Never move, rotate, scale, unpin, replace, permanently hide or delete the primary PDF or an `aligned_cad` DWG ImportInstance. Never move/rename/delete human anchors or levels (the agent may only add levels that the manifest marks `create`). Never delete existing model elements or modify existing family types unless the user gives separate explicit authorization. Rebar and reinforcement creation are prohibited.

## Type generation

Decision order: (1) reuse an exact verified match; (2) duplicate the closest validated parametric loadable-family type and set accessible parameters; (3) load a vetted RFA supplied/approved by the user; (4) block the type. Never reuse a mismatched type. Do not create in-place families. Treat system-family duplication (wall types) as unavailable unless the live tools explicitly support it.

Use source-scoped type names. Read every created type back and verify category, family, dimensions, material, reference plane and behavior before creating dependent instances.

## Payload and transaction rules

Execute dependency stages separately: types, grids, foundations, columns/pedestals/stems, framing, walls/floors/openings, metadata, QA. For each mutating stage: build and freeze the exact payload, hash its canonical form, preview when a dry-run exists, review, commit the identical payload, stop on the first failure or mismatch, query committed objects back and record ElementId + UniqueId. Dry-run IDs are temporary and never reused.

## Idempotency

Use stable source keys. Prefer `set_source_key`/`find_by_source_key` when available; otherwise keep an external source-key to UniqueId map and verified geometric/type matching. A rerun updates or skips a unique match; stop on zero/multiple ambiguous matches rather than creating a duplicate.

## QA

Numerical first: counts per category vs `expected_counts`, coordinates, dimensions, elevations vs the datum table, types, rotations, materials, joins/supports, duplicates, exclusions, warning deltas. The PDF overlay (view image, PDF visible) is diagnostic, with a looser tolerance than dimensioned geometry; hide the PDF for numerical checks only through a reversible view-only operation.
