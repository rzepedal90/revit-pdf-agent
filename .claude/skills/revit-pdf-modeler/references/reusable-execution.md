<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Reusable execution contracts

Do not copy and weaken helpers for each drawing. Status of the shipped helpers:

| Script | Status in this repo |
|---|---|
| `json_summary.mjs` | works as-is |
| `validate_manifest.mjs` | works as-is (adds the `expected_counts` rule) |
| `qa_invariants.mjs` | pure functions; consume measured evidence you must collect (usable once evidence is produced via `get_elements_info` / C#) |
| `execution_state.mjs` | `bindContract`, `identityIndex` pure; `reconcileLedger` needs an adapter (`callBatch`, `get_element_info`) |
| `execution_runner.mjs` | needs an adapter onto our MCP tools (see performance-execution.md) |

## Atomic placement recipes (design)

One creation followed by source-scoped settings and a query, all in one identical dry-run/commit unit. Instance updates must be `atomic`, `expectedCount: 1`, instance scope, selected by the exact source key (or by vetted Type Name plus empty source key only when the guarded baseline proves no other empty instances of that type exist). In our MCP this maps to: create tool + `set_parameter` + `find_elements`/`query_where` inside `batch` (when it exists) or a single reviewed C# snippet. Verify the live tool supports an expected-count guard before relying on it; otherwise pre-count and abort on mismatch. Rotation inside a recipe is not supported; block it or obtain an explicit two-step exception.

## Intent and restart

Recipes carry an immutable `intent` copy of their approved manifest row. Freeze approved canonical manifest/recipe hashes separately (`manifestHash`, `recipesHash`); never recompute them from a changed file at resume. `bindContract` binds authorization, contract identity and resolved intent but does NOT prove the compiler mapped geometry/units correctly: validation must independently compare payload coordinates (mm), type identities, level-relative offsets, rotations, materials and settings to the approved intent.

On every restart verify ALL ledger rows (including previously verified) through `reconcileLedger` before choosing remaining elements. If a commit timed out with no recorded ID, inspect source-key/geometry candidates; block ambiguous or absent evidence; never blindly create again. Do not use IsModified, counts or timestamps as model revision.

## Family and QA evidence

`qa_invariants.mjs` is fail-closed: missing material evidence blocks QA; both beam endpoints need native join state, 3D support candidates and verified narrow-phase contact (bounding boxes are broad-phase only). Enumerate approved unsupported exceptions by source key/endpoint. A placement profile fixes family/type fingerprint, MCP version, insertion plane, Z semantics, explicit instance parameters and configured-type material evidence; invalidate it after family/type/runtime changes. Set every offset explicitly. Keep blinding separate from structural concrete. These helpers do not certify structural capacity.

## Context budget

Keep payloads, readbacks and candidates in files. Use `node scripts/json_summary.mjs <file.json> <path> <limit> <fields>` (limits: 20 samples, 200-char strings, 8000 chars total). Discover only the tool schemas you need. Read detailed evidence only for failing/uncertain rows. Never print a full minified manifest.
