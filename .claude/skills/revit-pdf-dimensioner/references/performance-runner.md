<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
> Execution not yet supported in this MCP (no stable-reference resolver); analysis/manifest only.

# Deterministic execution (design reference, not wired to this MCP)

Everything below describes another addin's API (`callBatch`, `revit_get_dimensions_in_view`, stable references, `refresh_active_view`). It is kept as the target design for a future resolver-backed executor. Today: validate the manifest, keep evidence in files, summarize with `node scripts/json_summary.mjs <file.json> dimensions 5 source_key,status,role`, and report execution as blocked. Skip `review_inventory` (not ported).

Use `scripts/dimension_runner.mjs` rather than writing new resolution/batching loops for each session. It is an importable helper, not an autonomous authorization or QA system.

1. Validate the complete frozen manifest with `scripts/validate_dimension_manifest.mjs`. Preserve all resolved/blocked/excluded rows and selected groups. Derive payloads from validated intent, never trust an arbitrary `frozen_payload` without comparing it to intent.
2. Capture protected source/model baselines. Supply `guard` that verifies the exact live RVT path, version, target view/type and unchanged protected geometry before each dry-run and commit. Reject conflicting existing source keys/signatures. Commit authorization must come from the validated manifest and human-approved scope, not a hardcoded boolean.
3. Use `referenceCache(callRevit)` to resolve exact semantic selectors once per owning view/units within an uninterrupted run. Returned blocked rows remain blocked. Destroy this cache on any model/family change, reconnect, or restart; never reuse previous dry-run results just because a payload hash matches.
4. Build ordered stable-reference payloads in metres with expected values and original tolerance. Use `runBatches` with default 24 steps, `commit` false for preview, and an evidence writer that saves full responses to uniquely named JSON files before mutation. A failed batch stops; inspect failures, isolate affected rows and rerun only those with fresh dry-runs. Never silently change tolerance, face choice or scope.
5. The helper freezes payloads, hashes each batch, performs one atomic dry-run immediately before its identical commit, and stops on uncertain results without blind retry. Hashes identify payloads, not model freshness. Keep the project untouched by the human during execution. After interruption, rebuild live references and inspect source identities to avoid duplicates.
6. After commit, independently verify EVERY new dimension and protected baseline. Use paginated `revit_get_dimensions_in_view(compact:true)` for numerical/reference/type/identity QA after the ownership-based reader is installed. Use full readback for text/line/layout QA and reopen persistence verification. Do not interpret numerical pass as graphical pass. Preserve warning policy and native save/reopen checks.

Keep full source candidates, payloads, readback and failures in artifact files. Tool stdout should contain only counts, timing, changed/blocked source keys, hash and artifact paths. Read detailed evidence only for failures or uncertainty; avoid dumping megabyte manifests, full model inventories or repeated successful readbacks into the conversation. This policy reduces context volume, not the scope or strictness of validation.

Inspect evidence using `node scripts/json_summary.mjs <file.json> dimensions 5 source_key,status,role` rather than `Get-Content` on minified JSON. It limits samples to 20, string previews to 200 characters and total output to 8000 characters. For detailed investigation query the specific locus, not the complete source inventory.

Test the helper without Revit writes:

```
node --test scripts/dimension_runner.test.mjs
```

## Visible paced execution

For this user's workflow, prefer `../revit-pdf-modeler/scripts/execution_runner.mjs` (resolved from the skill root's parent) for committed elements, passing each validated dimension's frozen payload as one row. Provide exact source-key/signature matching, full value/reference/type verification, protected-target guards and `refresh_active_view`. The default pause is 200 ms after a completed element. Preview and read-only batching remain fast. This mode has per-element transactions and undo checkpoints; it cannot preserve whole-batch atomicity. Keep `runBatches` for explicitly atomic dependency stages and rollback previews. Never reuse a reference cache after any dry-run, commit, reconnect or reopen.

After reopen, an inactive copied view can return `AreReferencesAvailable=false` before Revit generates its graphics. Open the target through the native `open_view` API and re-read before diagnosing broken references. Still verify every stable reference and value; activation does not excuse actual unresolved references.
