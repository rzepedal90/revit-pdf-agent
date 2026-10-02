<!-- Original to this repository (lessons from the S301 benchmark run); structure follows pdftorevit-agent (MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer). -->
# Elevation / datum table (mandatory before any build)

Fill this table from the details and sections during ANALYZE. Store it as `datum_table` in the manifest: an object with integer `npt_mm`, `sf_mm`, per-category `rules` (`footing|column|beam|wall` each with `top` and `bottom`) and an evidence `rows` array (schema in [manifest-schema.md](manifest-schema.md#datum-table); validator enforces it in PLAN/EXECUTE). Every `rows` entry: `name`, `value_mm` (integer, relative to the stated `level_ref`), `level_ref` (Revit level name/ElementId or "absolute"), `evidence` (sheet + detail), `status` (`resolved`/`blocked`).

| Datum | Meaning | Typical use |
|---|---|---|
| N.P.T. | Nivel de piso terminado (finished floor) | reference for everything else |
| O.G. / N.O.G. | Original / natural ground | excavation, footing cover |
| S.F. | Sello de fundacion (underside of foundation) | footing bottom |
| Top of footing | S.F. + thickness | column/pedestal base |
| Top of pedestal / column / stub | per column detail | column Top Level/offset |
| Top of beam (V.F., cadenas) | per beam detail | beam Z offset |
| Blinding (hormigon pobre) | thickness and bottom/top | separate element, separate material |

Rules:

- No Z value is guessed, inherited from a family default or taken from a level name. Set every base/top level and offset explicitly and read it back.
- A foundation level alone does not define family insertion planes, beam top/bottom, column tops or wall constraints. Probe a configured type (place one test instance only in a scratch/dry-run context, or read the type parameters) before relying on offsets.
- Conflicts between details (e.g. a section says 5400 and the plan says 5300) are reported as one clarification with both sources.
- Blinding is its own element with its own material; do not fold it into structural concrete.
- QA compares created Z values to this table, not to the PDF overlay.
