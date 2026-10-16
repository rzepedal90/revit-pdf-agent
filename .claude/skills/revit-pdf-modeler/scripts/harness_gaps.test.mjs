// Regression tests for qa_model family-kind checks (level, offset, instance parameters) and pdf_lines --list-styles units.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runQa} from './qa_model.mjs';

const T = 'X/T/PARK';
const manifest = () => ({
  levels: [{name: 'Nivel 1', elevation_mm: 0, action: 'existing'}],
  type_manifest: [{source_key: T, status: 'resolved', category: 'parking', family: 'Plaza de aparcamiento 2D', type: '5000 x 2500 mm - 90°', material: '(none)'}],
  element_manifest: [
    {source_key: 'X/P/001', status: 'resolved', category: 'parking', type_key: T, geometry_mm: {x: 0, y: 0, rotation_deg: 0}, z_constraints: {level: 'Nivel 1', offset_mm: -3500}, execution_action: 'create',
      parameters: [{name: 'Comentarios', value: 'Accesible'}]},
  ],
  acceptance_tests: {expected_counts: {parking: 1}, category_aliases: {parking: ['Aparcamiento']}},
});
const readback = (over = {}) => ({items: [{id: 1, category: 'Aparcamiento', family: 'Plaza de aparcamiento 2D', type: '5000 x 2500 mm - 90°', levelName: 'Nivel 1', levelElevation: 0,
  location: {point: [0, 0, -3500], rotationDeg: 0}, bbox: {min: [0, -5000, -3500], max: [2500, 0, -3496.8]}, offsets: {hostOffset: -3500}, comments: 'Accesible', sourceKey: 'X/P/001', ...over}]});
const failed = (r, check) => r.failures.filter(f => f.check === check);

test('family kind: level, offset and Comments pass when matching', () => {
  const r = runQa(manifest(), readback(), undefined);
  assert.deepEqual(r.failures, []);
  for (const c of ['z_level', 'z_offset']) assert.equal(r.summary.totals[c]?.pass, 1, c);
});

test('family kind: wrong offset, level and comment each fail', () => {
  const r = runQa(manifest(), readback({offsets: {hostOffset: -2500}, levelName: 'Nivel 2', comments: ''}), undefined);
  assert.equal(failed(r, 'z_offset')[0]?.delta, 1000);
  assert.equal(failed(r, 'z_level').length, 1);
  assert.equal(failed(r, 'param:Comentarios').length, 1);
});

test('pdf_lines --list-styles reports model metres when calibrated', () => {
  const d = mkdtempSync(join(tmpdir(), 'pdfl-'));
  // 100 pt line at 1 pt = 100 mm -> 10 m
  writeFileSync(join(d, 'e.json'), JSON.stringify({segs: [{t: 'l', a: [0, 0], b: [100, 0], lw: 1, st: [0, 0, 0], fi: null}]}));
  writeFileSync(join(d, 'c.json'), JSON.stringify({X: [100, 0, 0], Y: [0, 100, 0]}));
  const script = fileURLToPath(new URL('./pdf/pdf_lines.mjs', import.meta.url));
  const cal = spawnSync(process.execPath, [script, join(d, 'e.json'), '--calib', join(d, 'c.json'), '--list-styles'], {encoding: 'utf8'});
  assert.match(cal.stdout, /^\s*10\.0 m /m);
  const raw = spawnSync(process.execPath, [script, join(d, 'e.json'), '--list-styles'], {encoding: 'utf8'});
  assert.match(raw.stdout, /^\s*100\.0 pt /m);
});
