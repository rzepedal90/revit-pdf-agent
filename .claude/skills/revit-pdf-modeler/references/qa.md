<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Numerical model QA

**Acceptance = numerical QA (`scripts/qa_model.mjs`). The PDF overlay is a diagnostic aid only**: use it to locate and explain a numerical failure, never to waive one. A model with an overlay that "looks right" and a failing report is not accepted.

## 1. Obtain the readback (read-only MCP tools)

1. `find_by_source_key` with `prefix` = the manifest key prefix (for example `1725-S401/`), `limit` up to 1000. Save the output as `sources.json`. Check `truncated: false` (otherwise page by narrower prefixes). `duplicates` is reported by the tool and consumed by QA.
2. Collect `matches[].id` and call `get_elements_info` with at most **200 ids per call** (hard limit of the tool), default fields (all). Save each response; pass them as one file containing an array of the responses (or a merged `items` list) as `readback.json`. Check every `notFound` is empty.
3. Run:

```
node scripts/qa_model.mjs --manifest manifest.json --readback readback.json --sources sources.json --out qa-report.json
```

Exit `0` = every check passes (warnings allowed), `1` = at least one failure, `2` = usage/unreadable input. Stdout is a bounded summary (totals per check and the first 20 failures); the complete rows are in `--out`. Inspect big reports with `scripts/json_summary.mjs qa-report.json failures 20 source_key,check,expected,actual,delta`.

All values are mm and degrees as returned by the tools (`delta = actual - expected`). Revit category names are the English display names (`Structural Foundations`); for a localized Revit add `acceptance_tests.category_aliases` (`{"structural_columns": ["Pilares estructurales"]}`).

## 2. Checks

| Check id | What is compared | Fails when |
|---|---|---|
| `identity` | each `resolved` row has exactly one element with its `sourceKey` | 0 or more than 1 element, or key in `duplicates` |
| `blocked_absent` | `blocked`/`excluded` rows plus `acceptance_tests.blocked_source_keys`/`excluded_source_keys` | any element carries the key |
| `extra_key` | model keys sharing the manifest prefix (`acceptance_tests.key_prefix`, default: first key up to and including the first `/`) | key is not in the manifest (generated extra) |
| `counts_expected` / `counts_rows` | elements per manifest category vs `expected_counts` / vs number of resolved rows | any mismatch |
| `category`, `family`, `type`, `material` | readback vs type row (`family`, `type`, `material` when present) | text differs (case-insensitive, trimmed); missing readback material when the type has one |
| `xy` | point: transformed `geometry_mm {x,y}` vs `location.point`; curve: both endpoints vs `location.start/end`, order-insensitive (Euclidean) | distance > `xy` |
| `rotation` | `rotation_deg + transform rotation` vs `location.rotationDeg`, mod 360 (mod 180 when the element or type row has `symmetric: true`) | difference > `rotation_tol_deg` |
| `z_top` (footing) | level elevation + `offset_mm` vs `topElevation` (bbox max z) | > `z` |
| `z_base`, `z_top` (column) | base/top level elevation + offsets vs bbox min/max z; `offsets.baseOffset/topOffset` and `baseLevel/topLevel` also compared when present | > `z`, level name differs |
| `z_end0/1`, `z_top` (beam) | reference-line z at each end = level + start/end offset vs `location` end z; top = reference + {Top: 0, Center: h/2, Bottom: h} using the max of both ends vs bbox max z; `startZOffset/endZOffset/zJustification` compared when present | > `z`; other justifications are `skip`ped with a note |
| `datum:<name>` | `datum_table` rows with `category` and/or `source_keys`, a name containing "top" and `value_mm` (+ `level_ref` elevation, or 0 for `absolute`) vs bbox max z | > `z` |
| `size_x`, `size_y` | footing/column bbox extents vs type `dimensions_mm`, swapped for 90/270 rotations | > `size`; rotations that are not multiples of 90 are `skip`ped with a note |
| `support` | column/pedestal XY inside a bbox of its `host_supports` (any footing when none) +/- `support_xy`, and column base z = support top within `support_z` | outside every candidate, or base/top gap > `support_z` |
| `support_end` | each beam end inside some column/footing/wall/other-beam bbox +/- `support_xy` in XY and +/- `support_z` in Z | no candidate and end not in `allowed_unsupported_ends` (delta = nearest bbox gap) |
| `overlap` (warning) | footing-footing bbox overlap in plan and z | overlap area > `overlap_threshold_mm2` and different `group` |

Support contact is a **bbox broad phase only** (`contact: "bbox-candidate"`, same candidate semantics as `verifyBeamEndpoints` in `qa_invariants.mjs`, with separate XY and Z tolerances). A pass is evidence of proximity, not of solid contact; concave, rotated or trimmed supports need a narrow-phase check before sign-off.

## 3. Tolerances (`acceptance_tests`)

| Key | Default |
|---|---|
| `tolerances_mm.xy` | 2 |
| `tolerances_mm.z` | 2 |
| `tolerances_mm.size` (fallback `dimension_tolerance_mm`) | 2 |
| `rotation_tol_deg` | 0.5 |
| `tolerances_mm.support_xy` | 50 |
| `tolerances_mm.support_z` | 2 |
| `overlap_threshold_mm2` | 10000 |

Other optional keys: `allowed_unsupported_ends` (`"<source_key>"` for both ends or `"<source_key>#0"` / `"#1"` for start / end; reported as warnings), `category_aliases`, `key_prefix`.

## 4. Manifest conventions QA relies on

- Element rows: `source_key`, `status`, `category` (`structural_foundations|structural_columns|structural_framing|structural_walls`), `type_key`, `geometry_mm` = `{x, y, rotation_deg}` (point) or `{start:[x,y], end:[x,y]}` (curve), `z_constraints` = footing/point `{level, offset_mm}`; column `{base_level, base_offset_mm, top_level, top_offset_mm}`; beam `{level, start_offset_mm, end_offset_mm, z_justification}`; optional `host_supports` (source keys), `group` (components of one composite footing such as F4a share it and may touch), `symmetric`.
- Type rows: `source_key`, `family`, `type`, `dimensions_mm` (X extent = `length`/`x`/`b`, Y extent = `width`/`y`/`h`/`depth`; for columns with only `width` and `depth`, X = width and Y = depth; `diameter` for round; beams use `height`/`h`/`depth`), `material`.
- `coordinate_basis.transform_to_model = {originMm:{x,y}, rotationDeg}`: model = origin + Rot(rotationDeg) * manifest point. Absent = identity (noted in the report).
- `levels: [{name, elevation_mm}]`; `datum_table` rows `{name, value_mm, level_ref, status}` plus `category` or `source_keys` to be machine-checked.

## 5. Fixtures

`tests/qa-synthetic/` holds a synthetic pass case (footings incl. a two-component F4a L-shape and a rotated FV pad, two columns, one beam). The tests in `scripts/qa_model.test.mjs` mutate it to reproduce each failure type (-3 mm datum error, missing stem, duplicate key, 31 mm unsupported beam end, rotation errors).
