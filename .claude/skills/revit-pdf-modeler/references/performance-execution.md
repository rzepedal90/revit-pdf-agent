<!-- Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer. See THIRD_PARTY_NOTICES.md. -->
# Batched inspection and paced creation

Status: `scripts/execution_runner.mjs` implements the design but targets another addin API (`callBatch`, `get_element_info`, `update_where`). It is **pending an adapter onto this MCP** (batch with dryRun, get_elements_info, query_where, set_parameter). Until then, follow the same discipline manually through our tools.

## Discipline to keep

- One element per checkpoint: freeze payload, validate intent against the frozen manifest, reconcile source identity, preview if possible, commit identical payload, independently verify, then continue. The stage is no longer atomic; never promise whole-stage rollback. Each committed element is a separate undo step.
- Default pacing: at least 200 ms between completed checkpoints, never inside an open transaction. Pacing is presentation only; it never alters coordinates, types, materials or tolerances.
- On interruption or uncertain transport, stop and reconcile recorded UniqueIds before resuming. Never blindly retry a create.
- Persist "planned" evidence before mutation and committed IDs before moving on (files, not chat).
- Report each decision concisely (source key + evidence) so the user can follow.
- Elements that need a placement plus mandatory settings (offsets, tops) must be one atomic recipe (placement + `set_parameter` together, or a single reviewed C# snippet) so wrong intermediate geometry never persists. Rotation after placement is a separate recorded step unless the create tool supports it.

## Inspection

Read in batches of at most 100 IDs (`get_elements_info` when available); preserve every returned row and check exact coverage and order. Filter by category/parameter instead of dumping the model. Full final readback and numerical QA cover every element.

## Test

`node --test ".claude/skills/**/*.test.mjs"` (runner tests exercise the original contract and stay green; they do not prove adapter correctness).
