// Original to this repository. Tests the manifest -> build_elements compiler against the synthetic S301-like fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileBuildPayloads, main} from './compile_build_payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'tests', 's301-synthetic', 'manifest.json');
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const NPT = {level: 'NPT'};
const TRANSFORM = {originMm: {x: 1000, y: 2000}, rotationDeg: 0};
const HASH = 'f7f05b0c90842fd7632f5095c43ed46b0ec25586041c673dd644e215c404318e';
const FILES = [
  'build_payload_001_grid.json', 'build_payload_002_footing.json', 'build_payload_003_column.json',
  'build_payload_004_beam.json', 'build_payload_005_wall.json',
];

test('stages are ordered grids, footings, columns, beams, walls; keys sorted within a stage', () => {
  const r = compileBuildPayloads(fixture());
  assert.deepEqual(r.payloads.map((p) => p.stage), ['grid', 'footing', 'column', 'beam', 'wall']);
  assert.deepEqual(r.payloads[0].payload.elements.map((e) => e.sourceKey), ['S301/grid/1', 'S301/grid/A', 'S301/grid/B']);
  assert.deepEqual(r.payloads[1].payload.elements.map((e) => e.sourceKey), ['S301/F1/001', 'S301/F4a/001', 'S301/F4a/002']);
  assert.deepEqual(r.payloads.map((p) => p.file), FILES);
});

test('exact payload for the footing stage (F1 and the two-part F4a)', () => {
  const p = compileBuildPayloads(fixture()).payloads[1].payload;
  assert.deepEqual(p, {
    dryRun: true, mode: 'upsert', manifestHash: HASH, transform: TRANSFORM,
    elements: [
      {sourceKey: 'S301/F1/001', kind: 'footing', familyName: 'Zapata_Rect', typeName: 'F1 2000x2000x1000',
        point: {x: 0, y: 0}, rotationDeg: 0, ...NPT, offsetMm: -2650},
      {sourceKey: 'S301/F4a/001', kind: 'footing', familyName: 'Zapata_Rect', typeName: 'F4a 1500x3000x1000',
        point: {x: 6000, y: 0}, rotationDeg: 0, ...NPT, offsetMm: -2650},
      {sourceKey: 'S301/F4a/002', kind: 'footing', familyName: 'Zapata_Rect', typeName: 'F4a 1500x3000x1000',
        point: {x: 6750, y: 1500}, rotationDeg: 90, ...NPT, offsetMm: -2650},
    ],
  });
});

test('exact payloads for grid, column, beam and wall', () => {
  const r = compileBuildPayloads(fixture());
  assert.deepEqual(r.payloads[0].payload.elements[1],
    {sourceKey: 'S301/grid/A', kind: 'grid', name: 'A', start: {x: 0, y: 0}, end: {x: 12000, y: 0}});
  assert.deepEqual(r.payloads[2].payload.elements[0], {
    sourceKey: 'S301/C1/001', kind: 'column', familyName: 'Columna_Rect', typeName: 'C 700x700',
    point: {x: 0, y: 0}, rotationDeg: 0, baseLevel: 'NPT', baseOffsetMm: -1650, topLevel: 'NPT', topOffsetMm: 0});
  assert.deepEqual(r.payloads[3].payload.elements[0], {
    sourceKey: 'S301/V1/001', kind: 'beam', familyName: 'Viga_Rect', typeName: 'V1 300x600',
    start: {x: 0, y: 0}, end: {x: 6000, y: 0}, level: 'NPT', startOffsetMm: 0, endOffsetMm: 0, zJustification: 'top'});
  assert.deepEqual(r.payloads[4].payload.elements[0], {
    sourceKey: 'S301/M1/001', kind: 'wall', familyName: 'Muro_Basico', typeName: 'M1 200',
    start: {x: 0, y: 6000}, end: {x: 6000, y: 6000}, baseLevel: 'NPT', baseOffsetMm: -1650,
    structural: true, locationLine: 'center', heightMm: 1650});
});

test('blocked rows are skipped and listed; counts and hash are stable', () => {
  const a = compileBuildPayloads(fixture());
  const b = compileBuildPayloads(fixture());
  assert.deepEqual(a, b);
  assert.equal(a.manifestHash, HASH);
  assert.deepEqual(a.skipped, [{sourceKey: 'S301/F9/001', status: 'blocked', category: 'structural_foundations'}]);
  assert.deepEqual(a.counts, {grid: 3, footing: 3, column: 2, beam: 1, wall: 1});
});

test('row order in the manifest does not change the payload elements', () => {
  const shuffled = fixture();
  shuffled.element_manifest.reverse();
  const a = compileBuildPayloads(fixture()).payloads.map((p) => p.payload.elements);
  const b = compileBuildPayloads(shuffled).payloads.map((p) => p.payload.elements);
  assert.deepEqual(a, b);
});

test('chunks never exceed the limit and never mix stages', () => {
  const m = fixture();
  const template = m.element_manifest.find((r) => r.source_key === 'S301/C1/001');
  for (let i = 0; i < 5; i++) m.element_manifest.push({...structuredClone(template), source_key: `S301/C9/${i}`});
  m.acceptance_tests.expected_counts.structural_columns = 7;
  const r = compileBuildPayloads(m, {maxPerChunk: 3});
  const columns = r.payloads.filter((p) => p.stage === 'column');
  assert.deepEqual(columns.map((p) => p.payload.elements.length), [3, 3, 1]);
  assert.ok(r.payloads.every((p) => p.payload.elements.length <= 3));
  assert.throws(() => compileBuildPayloads(m, {maxPerChunk: 501}), /chunk size/);
});

test('rejects unfrozen, non-EXECUTE or invalid manifests', () => {
  const unfrozen = fixture();
  unfrozen.manifest_frozen = false;
  assert.throws(() => compileBuildPayloads(unfrozen), /EXECUTE and manifest_frozen/);
  const bad = fixture();
  delete bad.element_manifest[3].z_constraints.offset_mm;
  assert.throws(() => compileBuildPayloads(bad), /offset_mm/);
});

test('CLI writes payload files and a bounded summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-'));
  const lines = [];
  assert.equal(main([FIXTURE, '--out-dir', dir], (l) => lines.push(l)), 0);
  assert.deepEqual(readdirSync(dir).sort(), [...FILES, 'compile_summary.json']);
  assert.ok(lines[0].length < 8000);
  assert.equal(JSON.parse(lines[0]).manifestHash, HASH);
  const written = JSON.parse(readFileSync(join(dir, FILES[1]), 'utf8'));
  assert.deepEqual(written, compileBuildPayloads(fixture()).payloads[1].payload);
});
