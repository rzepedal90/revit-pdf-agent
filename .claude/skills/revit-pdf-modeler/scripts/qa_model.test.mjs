// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runQa} from './qa_model.mjs';

const dir = fileURLToPath(new URL('../tests/qa-synthetic/', import.meta.url));
const load = n => JSON.parse(readFileSync(dir + n, 'utf8'));
const fx = () => ({manifest: load('manifest.json'), readback: load('readback.json'), sources: load('sources.json')});
const P = '9999-QA/';
const item = (rb, key) => rb.items.find(i => i.sourceKey === key);
const fails = (r, check, key) => r.failures.filter(f => f.check === check && (!key || f.source_key === key));

test('synthetic pass case has zero failures and covers every check family', () => {
  const {manifest, readback, sources} = fx();
  const r = runQa(manifest, readback, sources);
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  for (const c of ['identity', 'counts_expected', 'type', 'material', 'xy', 'rotation', 'z_top', 'z_base', 'size_x', 'support', 'support_end'])
    assert.ok(r.summary.totals[c]?.pass > 0, c);
});

test('readback accepts an array of outputs and works without a source index', () => {
  const {manifest, readback} = fx();
  const half = Math.floor(readback.items.length / 2);
  const r = runQa(manifest, [{items: readback.items.slice(0, half)}, {items: readback.items.slice(half)}], undefined);
  assert.deepEqual(r.failures, []);
});

test('-3 mm datum error on a footing top fails with delta -3', () => {
  const {manifest, readback, sources} = fx();
  const f = item(readback, P + 'F1/001');
  f.topElevation -= 3; f.bbox.max[2] -= 3;
  const r = runQa(manifest, readback, sources);
  const row = fails(r, 'z_top', P + 'F1/001')[0];
  assert.equal(row.delta, -3);
  assert.equal(r.ok, false);
});

test('2 mm error is within the default z tolerance', () => {
  const {manifest, readback, sources} = fx();
  const f = item(readback, P + 'F1/001');
  f.topElevation -= 2; f.bbox.max[2] -= 2;
  assert.equal(fails(runQa(manifest, readback, sources), 'z_top').length, 0);
});

test('missing anchor stem (column) fails identity and counts', () => {
  const {manifest, readback, sources} = fx();
  const key = P + 'C1/002';
  readback.items = readback.items.filter(i => i.sourceKey !== key);
  sources.matches = sources.matches.filter(m => m.sourceKey !== key);
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'identity', key).length, 1);
  assert.equal(fails(r, 'counts_expected', 'structural_columns').length, 1);
  assert.equal(fails(r, 'counts_rows', 'structural_columns')[0].delta, -1);
});

test('duplicate source key fails', () => {
  const {manifest, readback, sources} = fx();
  const orig = item(readback, P + 'C1/001');
  const copy = {...orig, id: 9001, uniqueId: 'dup'};
  readback.items.push(copy);
  sources.matches.push({id: 9001, uniqueId: 'dup', category: orig.category, type: orig.type, sourceKey: orig.sourceKey});
  sources.duplicates.push({sourceKey: orig.sourceKey, ids: [orig.id, 9001]});
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'identity', P + 'C1/001').length, 1);
  assert.match(fails(r, 'identity', P + 'C1/001')[0].note, /duplicate/);
});

test('extra generated key with manifest prefix and present blocked key fail', () => {
  const {manifest, readback, sources} = fx();
  const orig = item(readback, P + 'F1/001');
  readback.items.push({...orig, id: 9002, sourceKey: P + 'F99/001'});
  readback.items.push({...orig, id: 9003, sourceKey: P + 'F11/001'});
  readback.items.push({...orig, id: 9004, sourceKey: 'OTHER-PROJECT/X/1'});
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'extra_key').length, 1);
  assert.equal(fails(r, 'extra_key')[0].source_key, P + 'F99/001');
  assert.equal(fails(r, 'blocked_absent').length, 1);
  assert.equal(fails(r, 'counts_expected', 'structural_foundations').length, 1);
});

test('wrong type, family and material fail', () => {
  const {manifest, readback, sources} = fx();
  const c = item(readback, P + 'C1/001');
  c.type = 'C9 500x500'; c.family = 'Otra'; c.material = 'H-20';
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'type', P + 'C1/001').length, 1);
  assert.equal(fails(r, 'family', P + 'C1/001').length, 1);
  assert.equal(fails(r, 'material', P + 'C1/001').length, 1);
});

test('XY error beyond tolerance fails for point and curve elements, curve order-insensitive', () => {
  const {manifest, readback, sources} = fx();
  item(readback, P + 'C1/001').location.point[0] += 5;
  const b = item(readback, P + 'V1/001');
  [b.location.start, b.location.end] = [b.location.end, b.location.start]; // reversed is fine
  b.offsets = {startZOffset: -100, endZOffset: -100, zJustification: 'Top'};
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'xy', P + 'C1/001')[0].delta, 5);
  assert.equal(fails(r, 'xy', P + 'V1/001').length, 0);
});

test('missing stem support: column outside its host footing fails', () => {
  const {manifest, readback, sources} = fx();
  const fv = manifest.element_manifest.find(e => e.source_key === P + 'C1/001');
  fv.host_supports = [P + 'F4a/001'];
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'support', P + 'C1/001').length, 1);
});

test('column base 10 mm off the footing top fails support and z_base', () => {
  const {manifest, readback, sources} = fx();
  const c = item(readback, P + 'C1/001');
  c.bbox.min[2] += 10;
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'support', P + 'C1/001').length, 1);
  assert.equal(fails(r, 'z_base', P + 'C1/001')[0].delta, 10);
});

test('beam end 31 mm above its support fails with gap 31', () => {
  const {manifest, readback, sources} = fx();
  const b = item(readback, P + 'V1/001');
  b.location.end[2] = 31; // column top is 0
  const r = runQa(manifest, readback, sources);
  const row = fails(r, 'support_end', P + 'V1/001')[0];
  assert.equal(row.delta, 31);
  assert.match(row.note, /bbox-candidate/);
  assert.equal(r.ok, false);
});

test('beam end 31 mm outside support in XY: fails only when support_xy tolerance is tightened', () => {
  const {manifest, readback, sources} = fx();
  const b = item(readback, P + 'V1/001');
  b.location.end[0] = 6231; // column bbox max x = 6200
  assert.equal(fails(runQa(manifest, readback, sources), 'support_end').length, 0); // default 50 mm
  manifest.acceptance_tests.tolerances_mm.support_xy = 20;
  assert.equal(fails(runQa(manifest, readback, sources), 'support_end', P + 'V1/001').length, 1);
});

test('unsupported end listed in allowed_unsupported_ends is a warning, not a failure', () => {
  const {manifest, readback, sources} = fx();
  item(readback, P + 'V1/001').location.end[2] = 31;
  manifest.acceptance_tests.allowed_unsupported_ends = [P + 'V1/001#1'];
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'support_end').length, 0);
  assert.equal(r.warnings.filter(w => w.check === 'support_end').length, 1);
});

test('F4a L-shape: touching components in one group pass, ungrouped overlap warns', () => {
  const {manifest, readback, sources} = fx();
  const b = item(readback, P + 'F4a/002');
  b.bbox.min[1] -= 100; b.bbox.max[1] -= 100; // 100 mm x 1000 mm overlap = 1e5 mm2
  let r = runQa(manifest, readback, sources);
  assert.equal(r.warnings.filter(w => w.check === 'overlap').length, 0);
  for (const e of manifest.element_manifest) delete e.group;
  r = runQa(manifest, readback, sources);
  const w = r.warnings.filter(x => x.check === 'overlap');
  assert.equal(w.length, 1);
  assert.equal(w[0].actual, 100000);
  assert.equal(r.ok, true); // warnings do not fail
});

test('rotated FV: wrong rotation fails, swapped bbox is correct, symmetric mod 180 accepted', () => {
  const {manifest, readback, sources} = fx();
  const key = P + 'FV/001';
  const fv = item(readback, key);
  assert.equal(fails(runQa(manifest, readback, sources), 'size_x', key).length, 0); // 600 x 1200 after 90 deg
  fv.location.rotationDeg = 0;
  assert.equal(fails(runQa(manifest, readback, sources), 'rotation', key).length, 1);
  fv.location.rotationDeg = 270;
  assert.equal(fails(runQa(manifest, readback, sources), 'rotation', key).length, 1);
  manifest.element_manifest.find(e => e.source_key === key).symmetric = true;
  assert.equal(fails(runQa(manifest, readback, sources), 'rotation', key).length, 0);
});

test('wrong footprint size is detected, un-swapped rotated bbox fails', () => {
  const {manifest, readback, sources} = fx();
  const fv = item(readback, P + 'FV/001');
  const cx = (fv.bbox.min[0] + fv.bbox.max[0]) / 2, cy = (fv.bbox.min[1] + fv.bbox.max[1]) / 2;
  fv.bbox.min[0] = cx - 600; fv.bbox.max[0] = cx + 600; fv.bbox.min[1] = cy - 300; fv.bbox.max[1] = cy + 300;
  const r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'size_x', P + 'FV/001').length, 1);
  assert.equal(fails(r, 'size_y', P + 'FV/001').length, 1);
});

test('non right-angle rotation skips the bbox size check with a note', () => {
  const {manifest, readback, sources} = fx();
  manifest.element_manifest.find(e => e.source_key === P + 'FV/001').geometry_mm.rotation_deg = 30;
  item(readback, P + 'FV/001').location.rotationDeg = 30;
  const r = runQa(manifest, readback, sources);
  assert.ok(r.rows.some(x => x.check === 'size' && x.status === 'skip' && x.source_key === P + 'FV/001'));
});

test('beam top follows z_justification and type height; datum_table tops are checked', () => {
  const {manifest, readback, sources} = fx();
  const key = P + 'V1/001';
  manifest.element_manifest.find(e => e.source_key === key).z_constraints.z_justification = 'Bottom';
  item(readback, key).offsets.zJustification = 'Bottom';
  // Bottom justification: ref line is the beam bottom -> top = -100 + 400 = 300, readback still -100
  let r = runQa(manifest, readback, sources);
  assert.equal(fails(r, 'z_top', key)[0].expected, 300);
  manifest.datum_table = [{name: 'Top of footing F1', category: 'structural_foundations', source_keys: [P + 'F1/001'], value_mm: -1050, level_ref: 'absolute', status: 'resolved'}];
  r = runQa(manifest, readback, sources);
  assert.equal(r.rows.filter(x => x.check === 'datum:Top of footing F1' && x.status === 'pass').length, 1);
  manifest.datum_table[0].value_mm = -1053;
  assert.equal(fails(runQa(manifest, readback, sources), 'datum:Top of footing F1')[0].delta, 3); // delta = actual - expected
});

test('localized category names need aliases', () => {
  const {manifest, readback, sources} = fx();
  item(readback, P + 'C1/001').category = 'Pilares estructurales';
  assert.equal(fails(runQa(manifest, readback, sources), 'category').length, 1);
  manifest.acceptance_tests.category_aliases = {structural_columns: ['Pilares estructurales']};
  assert.equal(fails(runQa(manifest, readback, sources), 'category').length, 0);
});

test('transform_to_model rotation and origin are applied to manifest points', () => {
  const {manifest, readback, sources} = fx();
  manifest.coordinate_basis.transform_to_model.rotationDeg = 90;
  const r = runQa(manifest, readback, sources);
  assert.ok(fails(r, 'xy').length > 0);
  assert.ok(fails(r, 'rotation').length > 0);
});

test('CLI: exit 0 on pass, 1 on failure with bounded summary and --out, 2 on usage', () => {
  const script = fileURLToPath(new URL('./qa_model.mjs', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'qa-'));
  const base = ['--manifest', dir + 'manifest.json', '--readback', dir + 'readback.json', '--sources', dir + 'sources.json'];
  let p = spawnSync(process.execPath, [script, ...base, '--out', join(tmp, 'ok.json')], {encoding: 'utf8'});
  assert.equal(p.status, 0, p.stderr);
  assert.ok(existsSync(join(tmp, 'ok.json')));
  assert.equal(JSON.parse(p.stdout).ok, true);

  const {readback} = fx();
  item(readback, P + 'F1/001').topElevation -= 3; item(readback, P + 'F1/001').bbox.max[2] -= 3;
  const bad = join(tmp, 'bad-readback.json');
  writeFileSync(bad, JSON.stringify(readback));
  p = spawnSync(process.execPath, [script, '--manifest', dir + 'manifest.json', '--readback', bad, '--out', join(tmp, 'r.json')], {encoding: 'utf8'});
  assert.equal(p.status, 1, p.stderr);
  assert.ok(p.stdout.length < 8000);
  const out = JSON.parse(p.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.failures.count >= 1 && out.failures.sample.length <= 20);
  assert.equal(JSON.parse(readFileSync(join(tmp, 'r.json'), 'utf8')).ok, false);

  p = spawnSync(process.execPath, [script, '--manifest', dir + 'manifest.json'], {encoding: 'utf8'});
  assert.equal(p.status, 2);
  p = spawnSync(process.execPath, [script, '--manifest', 'nope.json', '--readback', 'nope.json'], {encoding: 'utf8'});
  assert.equal(p.status, 2);
});
