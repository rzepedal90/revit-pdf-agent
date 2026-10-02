# Third-party notices

## pdftorevit-agent

Portions of `.claude/skills/revit-pdf-modeler/` and `.claude/skills/revit-pdf-dimensioner/` (workflow rules, manifest schemas, validators, execution/QA helper scripts and their tests, S401 sample fixtures) and the benchmark in `CLAUDE.md` are adapted from
pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), which is itself based on KenLP/RevitMCPServer.

```
MIT License

Copyright (c) 2026 Le Phu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### What was adapted

- `.claude/skills/revit-pdf-modeler/SKILL.md` and `references/*.md`: workflow (ANALYZE/PLAN/EXECUTE), input contract, manifest schema, execution policy; rewritten for this repository's MCP tool names, millimetre units and Claude Code skill format, with additional rules.
- `.claude/skills/revit-pdf-modeler/scripts/validate_manifest.mjs` (+ test): Node port of `validate_manifest.py` and its unit tests, plus one new rule (`acceptance_tests.expected_counts`).
- `.claude/skills/revit-pdf-modeler/scripts/json_summary.mjs`, `execution_runner.mjs`, `execution_state.mjs`, `qa_invariants.mjs` and their tests, `atomic_recipe.test.mjs`: copied with a license header and notes (they assume the original addin API and await an adapter).
- `.claude/skills/revit-pdf-modeler/tests/s401-analysis/*`: sanitized synthetic fixtures.
- `.claude/skills/revit-pdf-dimensioner/`: SKILL.md and references rewritten (analysis/manifest only), `validate_dimension_manifest.mjs` (+ test, Node port of the Python validator and tests), `dimension_runner.mjs` and `json_summary.mjs` (+ tests) copied with headers.
- `CLAUDE.md`: operating rules and the S301 benchmark summarized from pdftorevit-agent's `CLAUDE.md`.

Not ported: `migrate_documentation.py`, `review_inventory.py`, `agents/openai.yaml`.
