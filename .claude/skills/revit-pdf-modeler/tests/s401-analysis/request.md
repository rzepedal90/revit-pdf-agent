# S401 Analysis-Only Behavioral Test

Use the `revit-pdf-modeler` skill in `ANALYZE` mode to prepare a draft manifest for the primary structural foundation PDF already imported, scaled, oriented, and pinned by the human in the active Revit foundation plan.

Do not alter Revit. Do not move or modify the PDF, origin grids, or levels. Do not model rebar. The initial request intentionally omits the requested model categories; ask the scope question before completing the manifest.

After receiving the scope answer, inspect the primary PDF, the live Revit project read-only, and any supplementary PDFs supplied by the human. Treat supplementary PDFs that are not aligned in Revit as non-positional evidence only. Propose measurable missing values, but keep them blocked until confirmed.
