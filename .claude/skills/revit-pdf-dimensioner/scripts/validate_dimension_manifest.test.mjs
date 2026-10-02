// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// Port of tests/test_validate_dimension_manifest.py to node:test (inline fixture), plus group-inventory and CLI checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateManifest} from './validate_dimension_manifest.mjs';

const sample = () => ({
  schema_version: '1.0', mode: 'EXECUTE', manifest_frozen: true,
  parent_model_manifest_sha256: 'abc',
  target: {rvt_path: 'C:/model.rvt', rvt_title: 'model', revit_version: '2027', mcp_version: 'custom'},
  source_ids: ['S401'],
  scope: {
    enabled: true, groups: ['grid_chain'], inventory_complete: true,
    group_inventory: {grid_chain: {total: 1, resolved: 1, blocked: 0, excluded: 0}},
    target_view_unique_ids: ['view-1'], intent: 'reproduce_source',
  },
  dimension_type: {unique_id: 'type-1', name: 'Structural', verified: true},
  layout_policy: {offset_units: 'paper_mm', local_lane_mm: 8, chain_lane_mm: 14, overall_lane_mm: 20},
  dimensions: [{
    source_key: 'S401/DIM/GRID-X/01', status: 'resolved', role: 'grid_chain',
    view_unique_id: 'view-1', dimension_type_unique_id: 'type-1',
    references: [
      {element_unique_id: 'g1', semantic_selector: 'axis', stable_representation: 'stable-1'},
      {element_unique_id: 'g2', semantic_selector: 'axis', stable_representation: 'stable-2'},
    ],
    line: {start_mm: [0, 0, 0], end_mm: [1000, 0, 0]},
    side: 'south', lane: 1, expected_values_mm: [1000], tolerance_mm: 1,
    evidence: ['S401 plan chain'], canonical_signature: 'sig-1', execution_action: 'create',
  }],
  clarifications: [],
  execution_policy: {
    commit_authorized: true, expected_revit_changes: 1, primary_pdf_immutable: true,
    allow_move_model_elements: false, allow_value_override: false,
  },
  acceptance_tests: {},
});
const any = (errors, text) => errors.some((e) => e.includes(text));

test('valid sample', () => {
  assert.deepEqual(validateManifest(sample()), []);
});

test('dimension scope is explicit', () => {
  const d = sample();
  d.scope.enabled = false;
  assert.ok(any(validateManifest(d), 'scope.enabled'));
});

test('value override is rejected', () => {
  const d = sample();
  d.dimensions[0].value_override = '1000';
  assert.ok(any(validateManifest(d), 'value_override'));
});

test('resolved references are deterministic', () => {
  const d = sample();
  delete d.dimensions[0].references[0].stable_representation;
  assert.ok(any(validateManifest(d), 'stable_representation'));
});

test('analysis cannot commit', () => {
  const d = sample();
  d.mode = 'ANALYZE';
  d.manifest_frozen = false;
  assert.ok(any(validateManifest(d), 'commit_authorized false'));
});

test('execute requires reconciled group inventory, unique signatures and in-scope roles', () => {
  const d = sample();
  d.scope.group_inventory.grid_chain.total = 2;
  assert.ok(any(validateManifest(d), 'scope.group_inventory.grid_chain.total=2 does not match dimension rows (1)'));
  const e = sample();
  e.dimensions.push({...structuredClone(e.dimensions[0]), source_key: 'S401/DIM/GRID-X/02'});
  e.scope.group_inventory.grid_chain = {total: 2, resolved: 2, blocked: 0, excluded: 0};
  assert.ok(any(validateManifest(e), 'duplicate canonical_signature'));
  const f = sample();
  f.dimensions[0].role = 'overall';
  assert.ok(any(validateManifest(f), 'outside selected scope'));
});

test('blocked rows must not execute; resolved rows need at least two references', () => {
  const d = sample();
  d.dimensions[0].status = 'blocked';
  assert.ok(any(validateManifest(d), "must use execution_action 'none'"));
  const e = sample();
  e.dimensions[0].references.pop();
  assert.ok(any(validateManifest(e), 'at least two references'));
});

test('CLI exit codes', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'validate_dimension_manifest.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'vdm-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(sample()));
  const ok = spawnSync(process.execPath, [script, good], {encoding: 'utf8'});
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'VALID');
  const badData = sample();
  badData.execution_policy.allow_value_override = true;
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify(badData));
  const r = spawnSync(process.execPath, [script, bad], {encoding: 'utf8'});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^INVALID\n- execution_policy\.allow_value_override must be false/);
  assert.equal(spawnSync(process.execPath, [script, join(dir, 'nope.json')], {encoding: 'utf8'}).status, 1);
});
