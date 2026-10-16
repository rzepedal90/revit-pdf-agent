# PDF vector tools (optional)

Node tools that turn the vector content of a human-aligned PDF plan into model-space (mm) geometry. They are optional: the rest of the skill needs no dependencies. Only `pdf_extract.mjs` needs `pdfjs-dist`; the `geom/` holes and pinch cleanup need `polygon-clipping`.

## Install

```
npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf
```

Tests in this folder skip the pdfjs-dependent cases when `node_modules` is missing, so `node --test ".claude/skills/**/*.test.mjs"` passes with or without the install.

## Tools

| Tool | Purpose |
|---|---|
| `pdf_extract.mjs <pdf> --page N --out f.json` | Text items and stroked/filled segments (page points) with stroke/fill colour and line width. Handles CTM, `re` rectangles and Bezier curves (flattened). |
| `pdf_calibrate.mjs f.json --grids grids.json --sym-min 3 --sym-max 6.5 --out calib.json` | Page to model affine from grid-label text (initial guess) refined on small square symbols at grid intersections. Reports rms/max (target rms < 50 mm), the matched grid names, missing intersections and the detected column list. |
| `pdf_lines.mjs f.json --calib calib.json --stroke r,g,b --lw w --region x0,y0,x1,y1 --out lines.json` | Style/region filter to model mm. `--list-styles` prints a style histogram first. `--band-midlines --thickness 80,600` turns paired band edges into centerlines; `--merge-parallel <mm>` merges doubled lines. |

`grids.json`: `{ "V": {"A":0,"B":8000}, "H": {"1":0,"2":6000}, "vExt": {"A":[y0,y1]}, "hExt": {"1":[x0,x1]} }` (V = vertical lines, name to model x; H = horizontal lines, name to model y; extents optional). Use `--points points.json` (`[{name,x,y}]`) to calibrate against known points instead of all intersections.

The geometry side (`../geom/`: `planar_faces.mjs`, `wall_clean.mjs`, `arc.mjs`) is documented in `../../references/cad-and-pdf-vectors.md`.
