// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// Port of tests/test_validate_manifest.py to node:test (same fixture) plus tests for the expected_counts rule and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateManifest} from './validate_manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, '..', 'tests', 's401-analysis', 'sample-manifest.json');
const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));
const errorsFor = (mutation) => {
  const candidate = sample();
  mutation(candidate);
  return validateManifest(candidate);
};
const any = (errors, text) => errors.some((e) => e.includes(text));

test('s401 analysis sample is valid', () => {
  assert.deepEqual(validateManifest(sample()), []);
});

test('analysis mode rejects revit writes', () => {
  const errors = errorsFor((d) => Object.assign(d.execution_policy, {commit_authorized: true, expected_revit_changes: 1}));
  assert.ok(any(errors, 'commit_authorized false'));
  assert.ok(any(errors, 'expected_revit_changes 0'));
});

test('rebar is always rejected', () => {
  assert.ok(any(errorsFor((d) => { d.scope.rebar = true; }), 'scope.rebar must be false'));
});

test('dimensions are optional and disabled by default', () => {
  assert.deepEqual(validateManifest(sample()), []);
  assert.equal(sample().documentation.dimensions.enabled, false);
});

test('enabled dimensions require scope', () => {
  const errors = errorsFor((d) => { d.documentation.dimensions = {enabled: true}; });
  assert.ok(any(errors, 'non-empty groups'));
  assert.ok(any(errors, 'non-empty target_views'));
  assert.ok(any(errors, 'valid intent'));
});

test('primary pdf must remain immutable', () => {
  assert.ok(any(errorsFor((d) => { d.sources[0].immutable = false; }), 'primary source must be human-aligned'));
});

test('unregistered supplement cannot control position', () => {
  const errors = errorsFor((d) => {
    const supplement = structuredClone(d.sources[0]);
    Object.assign(supplement, {
      source_id: '1725-S407-r0', role: 'supplementary', sheet: '1725-S407', registered_in_revit: false,
      positional_authority: true, human_aligned: false, human_scaled: false, pinned_expected: false, immutable: false,
    });
    d.sources.push(supplement);
  });
  assert.ok(any(errors, 'cannot have positional authority'));
});

test('blocked elements cannot be created', () => {
  assert.ok(any(errorsFor((d) => { d.element_manifest[0].execution_action = 'create'; }), "must use execution_action 'none'"));
});

test('source keys are unique', () => {
  const errors = errorsFor((d) => { d.element_manifest[0].source_key = d.type_manifest[0].source_key; });
  assert.ok(any(errors, 'duplicate source_key'));
});

// --- expected_counts rule (new) ---
const withResolved = (d, n, category = 'structural_foundations') => {
  d.scope.categories = [...new Set([...d.scope.categories, category])];
  for (let i = 0; i < n; i++) {
    const row = structuredClone(d.element_manifest[0]);
    Object.assign(row, {source_key: `T/${category}/${i}`, status: 'resolved', category, execution_action: 'create'});
    d.element_manifest.push(row);
  }
};

test('expected_counts matching resolved rows passes', () => {
  assert.deepEqual(errorsFor((d) => { withResolved(d, 3); d.acceptance_tests.expected_counts = {structural_foundations: 3}; }), []);
});

test('expected_counts mismatch fails', () => {
  const errors = errorsFor((d) => { withResolved(d, 3); d.acceptance_tests.expected_counts = {structural_foundations: 4}; });
  assert.ok(any(errors, 'expected_counts.structural_foundations=4'));
});

test('expected_counts ignores blocked rows and flags unlisted resolved categories', () => {
  const blockedOnly = errorsFor((d) => { d.acceptance_tests.expected_counts = {structural_foundations: 0}; });
  assert.deepEqual(blockedOnly, []);
  const unlisted = errorsFor((d) => {
    withResolved(d, 2, 'structural_columns');
    d.acceptance_tests.expected_counts = {structural_foundations: 0};
  });
  assert.ok(any(unlisted, 'expected_counts.structural_columns=0'));
});

test('expected_counts empty object or absent disables the rule; bad shape fails', () => {
  assert.deepEqual(errorsFor((d) => { withResolved(d, 2); d.acceptance_tests.expected_counts = {}; }), []);
  assert.deepEqual(errorsFor((d) => { withResolved(d, 2); delete d.acceptance_tests.expected_counts; }), []);
  assert.ok(any(errorsFor((d) => { d.acceptance_tests.expected_counts = [1]; }), 'expected_counts must be an object'));
  assert.ok(any(errorsFor((d) => { d.acceptance_tests.expected_counts = {structural_foundations: 'x'}; }), 'non-negative integer'));
});

// --- flow manifest ---
test('flow manifest authorizes custom categories and validates topology', () => {
  const stage = (id, categories, depends_on = []) => ({id, label: id, source: 'x', categories, depends_on});
  const ok = errorsFor((d) => {
    d.flow_manifest = {schema_version: 1, stages: [stage('stage:piles', ['structural_piles'])], qa: {enabled: true}};
    d.scope.categories.push('structural_piles');
  });
  assert.deepEqual(ok, []);
  const bad = errorsFor((d) => {
    d.flow_manifest = {schema_version: 1, stages: [stage('stage:a', ['x'], ['stage:b']), stage('stage:b', ['x'])], qa: {}};
  });
  assert.ok(any(bad, 'must precede'));
  assert.ok(any(bad, 'multiple owners'));
  assert.ok(any(bad, 'qa.enabled'));
});

// --- CLI ---
test('CLI exit codes and messages', () => {
  const script = join(here, 'validate_manifest.mjs');
  const run = (path) => spawnSync(process.execPath, [script, path], {encoding: 'utf8'});
  const good = run(SAMPLE);
  assert.equal(good.status, 0);
  assert.equal(good.stdout.trim(), 'VALID');
  const dir = mkdtempSync(join(tmpdir(), 'vm-'));
  const badPath = join(dir, 'bad.json');
  const bad = sample();
  bad.scope.rebar = true;
  writeFileSync(badPath, JSON.stringify(bad));
  const invalid = run(badPath);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /^INVALID\n- scope\.rebar must be false/);
  const garbagePath = join(dir, 'garbage.json');
  writeFileSync(garbagePath, '{nope');
  const garbage = run(garbagePath);
  assert.equal(garbage.status, 1);
  assert.match(garbage.stderr, /^INVALID: /);
  const arrayPath = join(dir, 'array.json');
  writeFileSync(arrayPath, '[]');
  const arr = run(arrayPath);
  assert.equal(arr.status, 1);
  assert.match(arr.stderr, /top-level JSON value must be an object/);
  assert.equal(run(join(dir, 'missing.json')).status, 1);
});

// --- build-ready conventions (PLAN/EXECUTE) ---
import {manifestWarnings} from './validate_manifest.mjs';
const S301 = join(here, '..', 'tests', 's301-synthetic', 'manifest.json');
const exec = (mutation) => {
  const m = JSON.parse(readFileSync(S301, 'utf8'));
  mutation(m);
  return validateManifest(m);
};
const row = (m, key) => m.element_manifest.find((r) => r.source_key === key);

test('synthetic S301 EXECUTE fixture is valid, also as PLAN', () => {
  assert.deepEqual(exec(() => {}), []);
  assert.deepEqual(exec((m) => { m.mode = 'PLAN'; m.manifest_frozen = false; m.execution_policy.commit_authorized = false; }), []);
});

test('ANALYZE is lenient about datum_table (warning only); PLAN/EXECUTE require it', () => {
  assert.deepEqual(validateManifest(sample()), []);
  assert.ok(manifestWarnings(sample()).some((w) => w.includes('datum_table')));
  assert.ok(any(exec((m) => { delete m.datum_table; }), 'datum_table must be an object'));
  assert.ok(any(exec((m) => { delete m.datum_table.sf_mm; }), 'datum_table.sf_mm'));
  assert.ok(any(exec((m) => { m.datum_table.npt_mm = 0.5; }), 'datum_table.npt_mm'));
  assert.ok(any(exec((m) => { delete m.datum_table.rules.beam; }), 'datum_table.rules.beam'));
  assert.ok(any(exec((m) => { m.datum_table.rules.wall.top = ''; }), 'datum_table.rules.wall'));
  assert.ok(any(exec((m) => { delete m.coordinate_basis.transform_to_model; }), 'transform_to_model'));
});

test('resolved rows need per-kind geometry and z fields as integer mm', () => {
  assert.ok(any(exec((m) => { row(m, 'S301/F1/001').geometry_mm.x = 10.5; }), 'geometry_mm.x/y must be integers'));
  assert.ok(any(exec((m) => { delete row(m, 'S301/F1/001').geometry_mm.rotation_deg; }), 'rotation_deg'));
  assert.ok(any(exec((m) => { delete row(m, 'S301/F1/001').z_constraints.level; }), 'z_constraints.level'));
  assert.ok(any(exec((m) => { row(m, 'S301/C1/001').z_constraints.top_offset_mm = '0'; }), 'top_offset_mm'));
  assert.ok(any(exec((m) => { delete row(m, 'S301/V1/001').z_constraints.z_justification; }), 'z_justification'));
  assert.ok(any(exec((m) => { row(m, 'S301/V1/001').geometry_mm.end = [1, 2, 3]; }), 'start/end'));
  assert.ok(any(exec((m) => { row(m, 'S301/V1/001').geometry_mm.end = [1.5, 2]; }), 'start/end'));
  assert.ok(any(exec((m) => { row(m, 'S301/M1/001').z_constraints.top_level = 'NPT'; }), 'exactly one of'));
  assert.ok(any(exec((m) => { delete row(m, 'S301/M1/001').z_constraints.height_mm; }), 'exactly one of'));
  assert.ok(any(exec((m) => { delete row(m, 'S301/grid/A').name; }), 'name is required for grids'));
  assert.ok(any(exec((m) => { row(m, 'S301/F1/001').type_key = 'nope'; }), 'type_key does not reference'));
  assert.ok(any(exec((m) => { row(m, 'S301/F1/001').execution_action = 'none'; }), "execution_action 'create'"));
  assert.ok(any(exec((m) => { row(m, 'S301/F4a/001').group = ''; }), 'group'));
});

test('resolved type rows need family, type, integer dimensions_mm and material', () => {
  const type = (m) => m.type_manifest[0];
  assert.ok(any(exec((m) => { delete type(m).family; }), '.family is required'));
  assert.ok(any(exec((m) => { delete type(m).type; }), '.type is required'));
  assert.ok(any(exec((m) => { type(m).dimensions_mm.b = 20.5; }), 'dimensions_mm'));
  assert.ok(any(exec((m) => { delete type(m).material; }), '.material is required'));
});
