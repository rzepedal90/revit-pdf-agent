<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
> Execution not yet supported in this MCP (no stable-reference resolver); analysis/manifest only.

# Dimension Workflow

## Select deliverables

Record `enabled: true`, target views, and only the user-selected groups:

- `grid_chain`: exterior/interior grid strings.
- `overall`: overall or partial building extents.
- `element_size`: footing, column, wall, or beam width/length.
- `element_offset`: grid-to-column, grid-to-footing, or similar offsets.
- `support_chain`: repeated support spacing or bay dimensions.
- `oblique_chain`: straight dimensions along a non-orthogonal axis.

Use `graphic_only` for marks that communicate intent but are not reproducible as a native linear dimension. Use `excluded_detail` for reinforcement, details, sections/elevations, spots, angles, radii, and other out-of-scope annotations.

## Resolve references

Represent each witness reference semantically before resolving it in Revit:

- Grid: grid UniqueId plus `axis`.
- Wall: UniqueId plus explicit `centerline`, `core_center`, `core_exterior`, `core_interior`, `finish_exterior`, or `finish_interior`.
- Family instance: UniqueId plus a named strong reference when available; otherwise a planar face selected by expected normal, origin/projection, and tolerance.
- Beam: UniqueId plus `location_axis` or an explicit planar face selector.

Store both the semantic selector and resolved stable representation. For `planar_face`, choose an expected point inside the intended trimmed face and away from edges; plane distance alone cannot distinguish coplanar nested solids. Reject nondeterministic selections such as "first face". Re-resolve after reopen and confirm that the stable reference still targets the intended object.

## Validate values before layout

Compute every segment from model geometry and compare it with the source value in millimetres. The PDF's written value controls documentation intent, but the dimension must report the actual model value. Stop on a mismatch outside the approved tolerance; never use `ValueOverride`.

For ambiguous or unreadable source values, leave the proposal blocked and ask one concise question. Do not infer a critical dimension from visual scale when a written dimension should exist in another source.

## Lay out dimension lines

Specify offsets in paper millimetres and convert using the target view scale. Keep related strings on consistent lanes:

1. local element sizes nearest the model,
2. grid/support chains outside them,
3. overall dimensions outermost.

Use the verified view right/up directions and crop boundary. Place an oblique chain parallel to its measured axis. PDF graphics may guide lane choice but never change the model reference geometry.

Detect obvious collisions with crops, view annotations, and neighboring dimension text. If automatic text placement is inadequate and the MCP lacks deterministic layout editing, report the affected dimensions for human cleanup rather than improvising.

## Canonical identity

Use a stable source key such as `1725-S401/DIM/GRID-X/01`. Build a canonical signature from the target view UniqueId, role, ordered semantic reference signatures, dimension-line side/lane, and DimensionType UniqueId.

Persist the source key on creation when supported. Otherwise maintain an external source-key-to-UniqueId map and verify the signature before adopting an existing dimension.

## MCP capability gate

Execution requires equivalents of:

1. list DimensionTypes and their relevant display/unit properties;
2. resolve semantic selectors to stable references;
3. create an aligned dimension using explicit stable references and DimensionType;
4. read dimensions in a view, including references, segments, values, text positions, and source keys;
5. optionally update text/layout without changing the measured value;
6. execute a view/region batch with dry-run and controlled warning handling.

If only a basic aligned-dimension command exists, restrict execution to cases where its reference ordering and selection are demonstrably deterministic, normally straight grid chains. Keep other roles blocked.

## QA and completion

Verify exact expected counts by view and role; OwnerViewId, DimensionType, ordered references, and segment count; each model segment versus the written PDF value within tolerance; desired unit formatting through DimensionType; stable references after save/reopen; no duplicate canonical signatures; zero unexpected warning delta; no obvious crop or text collisions; and an exception list for blocked or human-cleanup items.

Maintain a reconciliation table for every selected group: inventoried, resolved, created, skipped, blocked, and excluded. Counts must balance before reporting completion. A completed batch is only a checkpoint while another selected group has unresolved or unexecuted rows. Use the MCP document-lifecycle recipe for the final persistence check instead of mouse/keyboard automation when available.
