<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Input Contract

Collect only information that changes modeling decisions. Use integer millimetres for manifest coordinates and dimensions (our create tools take millimetres too).

## Source register

For every source record: stable source ID, absolute path, SHA-256, sheet number, revision, issue date/status, units, page, orientation, and drawing regions with individual scales.

- Exactly one `primary` source = the human-aligned, pinned Revit underlay.
- Record whether each supplementary source is registered in Revit. Unregistered sources give non-positional evidence only.
- Do not trace detail geometry from a sheet scaled for its plan viewport; read detail geometry from written dimensions.
- Extract text/vector data from the PDF first (labels, dimension strings, schedules). Count labels per mark (F1, F4, P1 ...) now; these counts feed `acceptance_tests.expected_counts`.

## Target guard

Record expected RVT full path and title, Revit version, MCP version, active view, unit system, phase, workset, design option. Abort execution if the active document does not match (read via `get_current_view_info` / `analyze_model_statistics` or a read-only `send_code_to_revit`).

Record whether the MCP exposes `get_spatial_reference`. When available, capture one read-only response for the primary PDF/image, anchor grids and placement view. When unavailable use the reviewed read-only C# fallback or keep spatial execution blocked. Do not ask the human to derive internal coordinates by hand as the normal workflow.

## Scope

Record selected categories (ask once if absent): `grids`, `structural_columns`, `structural_framing`, `structural_foundations`, `structural_walls`, `structural_floors`, `openings`. `rebar` is always `false`; never offer reinforcement.

## Optional documentation

`documentation.dimensions.enabled` true/false, with `groups`, `target_views`, `intent` when true. In this MCP dimension execution is not yet supported; enabling dimensions yields an analysis/manifest deliverable only (see `revit-pdf-dimensioner`).

## Human registration

Record primary PDF element ID, pinned state, placement view, scale, rotation, immutable flag; anchor grid ElementIds and UniqueIds. Define origin (e.g. "grid E / grid 8a"), positive X and Y, project/shared coordinate policy, exact coordinates (mm) for every resolved grid, and at least three non-collinear registration checks.

Derive the transform from `get_spatial_reference` (image center + four corner points, exact grid curves and intersections, view right/up/view directions); treat reported `pinned` and owner view as runtime verification. Compare PDF-derived anchor lines with Revit grid curves for origin, X and Y direction/scale. The agent may create requested non-anchor grids after approval (`create_grid`) but never alter anchors.

## Levels, datums and vertical rules

Record level names, ElementIds, elevations, and element-specific Z rules, plus the mandatory **datum table** ([elevation-datum-table.md](elevation-datum-table.md)): N.P.T., O.G./N.O.G., S.F., tops of footings/pedestals/columns/beams, blinding. A foundation level alone does not define insertion planes or tops.

## Type inputs

For each required type record category, source mark, base family/type, dimensions, material, insertion/reference plane, hosting, origin, rotation rule, parameter mapping, validation method. Existing names are labels, not proof of geometry: read parameters (`get_available_family_types`, `get_elements_info`) and confirm an exact match. If absent, apply the **missing types rule**: duplicate the closest validated family type and configure it from the drawing details; never reuse a mismatched type; ask if information is missing.

Combined, eccentric and L-shaped foundations require the exact footprint (or abutting rectangular components), insertion point, every supported axis, offsets from axes to edges and rotation.

## Small elements and expected counts

List every anchor stem, pedestal, muerto/dead-man, FV pad, beam link and stub as its own element. State expected counts per category and cross-check them against PDF label counts. Disagreements become clarifications.

## Clarifications

For each missing value: topic and affected source keys; state `blocked` until answered; evidence and drawing locations; raw measurement/candidate range; proposed nominal value if defensible; one question; human answer + timestamp. Ask all of them in **one consolidated round**.

Example: a column measuring about 690-710 mm may propose `700 x 700 mm`, but ask whether it is square and which locations share the type.

## Readiness gate

Ready to freeze only when every in-scope object is `resolved`, `blocked` or `excluded`; resolved objects have evidence; blocked objects are absent from executable payloads; the datum table is complete; and expected counts per category are stated and cross-checked.
