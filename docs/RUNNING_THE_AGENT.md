# Running the PDF-to-Revit agent

This guide is for the person preparing a Revit model so the agent can turn a structural plan PDF (foundations, columns, framing, walls, grids) into native Revit elements. The agent follows the `revit-pdf-modeler` skill in `.claude/skills/revit-pdf-modeler/`.

The agent reads the drawing, asks you its questions **once**, writes a manifest you approve, builds the elements and then checks them numerically. It never moves your PDF, your anchor grids or your levels, and it never models rebar.

## 1. One-time setup

1. **Build and install the Revit add-in.** Close Revit first, then run:
   ```bash
   dotnet build mcp-servers-for-revit.sln -c "Debug R26"
   ```
   The Debug configuration copies the add-in into `%AppData%\Autodesk\Revit\Addins\2026\`. Use `R25`, `R24` and so on for other Revit versions. Never build a Debug configuration while Revit is open.
2. **Build the MCP server:** `cd server && npm install && npm run build`.
3. **Register the server with Claude Code**, using a tool profile so only the needed tools are loaded:
   ```bash
   claude mcp add mcp-server-for-revit -e REVIT_MCP_PROFILE=pdf_modeling_analyze,pdf_modeling_execute -- node <repo>/server/build/index.js
   ```
4. **Start Revit.**
   - Click **Always Load** if Revit asks about the add-in.
   - On the **mcp-servers-for-revit** ribbon tab, open **Settings**, enable all commands and click **Save**.
   - Click the **toggle button** to start the MCP service. It listens on `localhost:8080`.
5. **Check the connection.** Ask Claude to run `say_hello`. A dialog should appear in Revit.

Requirements: Revit 2020–2026, .NET SDK 8+, Node.js 18+ (22+ to run the skill tests). Python is not needed.

## 2. What you prepare in Revit (the inputs)

Do these steps by hand. The agent checks them but never fixes them for you.

| # | Input | How to do it | Why the agent needs it |
|---|---|---|---|
| 1 | **Revit project** | Open the target `.rvt` (the right discipline template, H-30 and other materials loaded if you have them). | Everything is built here. |
| 2 | **Levels** | Create or confirm the levels the plan uses, e.g. `Nivel Fundación` (−1.65 m) and `Nivel 1°` (0.00). | Every element's vertical position is set relative to a named level. |
| 3 | **Primary PDF** | In the plan view of the level you are modeling (e.g. `Nivel Fundación`), **Insert → PDF**, then choose the right page. | This is the drawing the agent reads positions from. |
| 4 | **Scale** | Scale the PDF to real size. Check it by measuring a dimensioned distance, for example 1000 between two grids must measure 10.00 m. Set the plan's scale (e.g. 1:125) via the image's scale parameters. | Positions taken from the drawing are only correct if the scale is. |
| 5 | **Orientation** | Rotate or move the PDF so the plan is where you want it in the model. | The agent never moves the PDF. |
| 6 | **Two anchor grids** | Draw **one vertical and one horizontal grid** exactly on two grid lines of the PDF. Give them the **same names as in the drawing**, e.g. `s0` and `G`. Ideally use grids near opposite corners or at the plan's origin. | These two grids tie the drawing to the model. All other coordinates are measured from them. |
| 7 | **Pin** | Pin the PDF and both anchor grids. | Protects the alignment; the agent verifies the pin state. |
| 8 | **Supplementary sheets** | Put the other sheets (details, sections, schedules, other sectors) in one folder and give the agent the path. Do **not** import them unless you align and pin them too. | Sizes, thicknesses and depths often live on detail sheets. Unaligned sheets are used only for that kind of information, never for positions. |
| 9 | **Scope** | Decide which categories to model: grids, structural foundations, columns, framing, walls, floors/slabs, openings. Also decide whether you want native dimensions (analysis only for now). | The agent models only what you select. |
| 10 | **Project facts you already know** | Anything not on the sheets: concrete grade, blinding thickness and material (e.g. 50 mm "Hormigon pobre"), column sizes, where column stubs stop, the sector boundary. | These become "human-confirmed" evidence, which ranks above anything read from the drawing. |

## 3. Starting a run

In Claude Code, opened in this repository, say for example:

> Model the foundations of the PDF in the open Revit project. Primary sheet: 1725-S301 (already imported, scaled 1:125, anchors `s0` and `G`, pinned). Supplementary sheets are in `G:\...\Auto Modeling\`. Scope: grids, foundations, columns, framing, walls. No dimensions.

Use **Opus** for this conversation. The agent may hand execution and QA to a **Sonnet** subagent.

## 4. What happens next

1. **ANALYZE (read-only).** The agent checks your setup (PDF present, scaled and pinned, anchors, levels), reads the drawing text and dimensions, and fills an **elevation table** (N.P.T., O.G., S.F., tops of footings, pedestals and beams, blinding) from the details. It then drafts the manifest: one row per element, types, positions in mm, expected counts per category.
2. **One round of questions.** You get a single list. Each question comes with the evidence and a proposed value. Typical ones:
   - Is this column 700×700 everywhere?
   - Where do the column stubs stop?
   - What is the slab thickness?
   - What does the blue hatching mean?
   - Is this element in our sector?
3. **Approval.** You approve the coordinate table, the elevation table, the type plan, the element list with expected counts, and what's excluded or blocked. The manifest is then **frozen** and validated (`validate_manifest.mjs`).
4. **EXECUTE.**
   - Missing family types are duplicated from the closest matching type and configured from the details.
   - Elements are built in stages through `build_elements`: grids, footings, columns, beams, walls.
   - Each stage is first dry-run, then committed. Every element carries a source key such as `1725-S301/F3/017`, so a rerun updates elements instead of duplicating them.
5. **QA.** `qa_model.mjs` compares every element against the manifest and reports:
   - counts, types and materials
   - XY position (±2 mm), rotation, elevations and sizes
   - columns standing on footings, beam ends landing on supports
   - duplicates

   The PDF overlay image is only a visual check. The numbers decide pass or fail.
6. **Report.** You get the element counts, the QA result, the remaining blocked items and the open questions.

## 5. Common problems

| Symptom | Fix |
|---|---|
| `connect to revit client failed` | Revit isn't running, or the MCP service toggle on the ribbon is off. |
| `Method '<name>' not found` | The command isn't enabled in **Settings**, or the add-in is outdated. Rebuild with Debug while Revit is closed. |
| Agent says spatial execution is **blocked** | The PDF isn't pinned, the anchor grids are missing or misnamed, or the scale check failed. Fix it in Revit and tell the agent to re-check. |
| Positions are off by a constant amount | One anchor grid isn't exactly on its PDF line. Re-place it, then re-run (reruns update, they don't duplicate). |
| Elements are at the wrong height | An elevation table entry is wrong. Correct the answer; the agent recompiles and upserts. |

## 6. Files the agent produces

The agent keeps these in a working folder per run (not in git): `manifest.json` (frozen), `payloads/*.json`, the dry-run and commit results, `readback.json` and `qa_report.json`. Large JSON stays on disk; the conversation only sees short summaries.
