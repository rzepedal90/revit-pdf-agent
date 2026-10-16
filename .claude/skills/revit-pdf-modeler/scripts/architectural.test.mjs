// Original to this repository. Tests for the architectural / CAD-aligned conventions: floors, architectural walls,
// levels (existing|create), aligned_cad sources, snapped columns, scope-aware datum table, QA of floors/levels.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateManifest, manifestWarnings} from './validate_manifest.mjs';
import {compileBuildPayloads, main} from './compile_build_payload.mjs';
import {runQa} from './qa_model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'tests', 'arch-synthetic');
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const manifest = () => load('manifest.json');
const readback = () => load('readback.json');
const errorsFor = (mutate, mode) => {
  const m = manifest();
  if (mode) m.mode = mode;
  mutate(m);
  return validateManifest(m);
};
const any = (errors, text) => errors.some((e) => e.includes(text));
const row = (m, key) => m.element_manifest.find((r) => r.source_key === key);
const FLOOR = 'ARQ-01/L/001';
const COL1 = 'ARQ-01/C/001';

// ---- validator: fixture, floors ------------------------------------------------------------------------------------
test('architectural fixture is valid as EXECUTE and PLAN, with no warnings', () => {
  assert.deepEqual(validateManifest(manifest()), []);
  const plan = manifest();
  plan.mode = 'PLAN';
  plan.manifest_frozen = false;
  assert.deepEqual(validateManifest(plan), []);
  assert.deepEqual(manifestWarnings(manifest()), []);
});

test('floor rows: boundary loops are validated', () => {
  assert.ok(any(errorsFor((m) => { delete row(m, FLOOR).geometry_mm.boundary; }), 'boundary must be a non-empty list of loops'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm.boundary = []; }), 'boundary must be a non-empty list'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm.boundary[0] = [[0, 0], [10, 0]]; }), 'at least 3'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm.boundary[0][1] = [20000.5, 0]; }), 'integer mm'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm.boundary[0].push([0, 0]); }), 'consecutive duplicate'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm.boundary[0] = [[0, 0], [1000, 0], [2000, 0]]; }), 'zero area'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).geometry_mm = {x: 0, y: 0}; }), 'boundary must be'));
});

test('floor rows: z_constraints {level, offset_mm} and type are required', () => {
  assert.ok(any(errorsFor((m) => { delete row(m, FLOOR).z_constraints.offset_mm; }), 'z_constraints.offset_mm'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).z_constraints.level = ''; }), 'z_constraints.level'));
  assert.ok(any(errorsFor((m) => { delete row(m, FLOOR).type_key; }), 'type_key'));
  assert.ok(any(errorsFor((m) => { row(m, FLOOR).structural = 'no'; }), 'structural must be a boolean'));
});

test('floors, architectural_walls and levels are accepted scope categories; others stay rejected', () => {
  assert.ok(any(errorsFor((m) => { m.scope.categories.push('ceilings'); }), 'unsupported scope categories: ceilings'));
  assert.ok(any(errorsFor((m) => { m.scope.categories = m.scope.categories.filter((c) => c !== 'floors'); }), 'outside selected scope: floors'));
});

test('architectural walls: structural true is rejected, structural false and omitted are fine', () => {
  assert.ok(any(errorsFor((m) => { row(m, 'ARQ-01/W/001').structural = true; }), 'must not set structural true'));
  assert.deepEqual(errorsFor((m) => { delete row(m, 'ARQ-01/W/001').structural; }), []);
  assert.ok(any(errorsFor((m) => { delete row(m, 'ARQ-01/W/001').z_constraints.base_level; }), 'z_constraints.base_level'));
});

// ---- validator: levels ---------------------------------------------------------------------------------------------
test('levels: action existing|create, integer elevation, create requires the levels scope', () => {
  assert.ok(any(errorsFor((m) => { m.levels[0].action = 'rename'; }), "action must be 'existing' or 'create'"));
  assert.ok(any(errorsFor((m) => { delete m.levels[0].action; }), "action ('existing'|'create') is required"));
  assert.ok(any(errorsFor((m) => { m.levels[0].elevation_mm = -8000.5; }), 'elevation_mm must be an integer'));
  assert.ok(any(errorsFor((m) => { m.levels[1].name = m.levels[0].name; }), 'duplicate level name'));
  assert.ok(any(errorsFor((m) => { m.scope.categories = m.scope.categories.filter((c) => c !== 'levels'); }), "requires 'levels' in scope"));
  assert.ok(any(errorsFor((m) => { m.levels[0].npt_mm = 50.5; }), 'npt_mm must be an integer'));
});

test('levels with only existing levels do not need the levels scope; legacy rows without action stay valid', () => {
  assert.deepEqual(errorsFor((m) => {
    m.scope.categories = m.scope.categories.filter((c) => c !== 'levels');
    for (const l of m.levels) l.action = 'existing';
  }), []);
  assert.deepEqual(errorsFor((m) => {
    m.scope.categories = m.scope.categories.filter((c) => c !== 'levels');
    for (const l of m.levels) delete l.action;
  }), []);
});

// ---- validator: datum table without foundations --------------------------------------------------------------------
test('datum table: no sf_mm without foundations; npt_mm optional only when every level has npt_mm', () => {
  const m = manifest();
  assert.equal(m.datum_table.sf_mm, undefined);
  assert.equal(m.datum_table.npt_mm, undefined);
  assert.deepEqual(validateManifest(m), []);
  assert.ok(any(errorsFor((x) => { delete x.levels[2].npt_mm; }), 'datum_table.npt_mm must be an integer'));
  assert.deepEqual(errorsFor((x) => { delete x.levels[2].npt_mm; x.datum_table.npt_mm = 58000; }), []);
});

test('datum table: rules are required only for categories in scope, floor included; sf_mm when foundations in scope', () => {
  assert.ok(any(errorsFor((m) => { delete m.datum_table.rules.floor; }), 'datum_table.rules.floor'));
  assert.ok(any(errorsFor((m) => { m.datum_table.rules.wall.top = ''; }), 'datum_table.rules.wall'));
  assert.deepEqual(errorsFor((m) => { m.datum_table.rules.beam = {}; }), []); // beams not in scope: ignored
  const withFoundations = errorsFor((m) => {
    m.scope.categories.push('structural_foundations');
    m.datum_table.rules.footing = {top: 'a', bottom: 'b'};
  });
  assert.ok(any(withFoundations, 'datum_table.sf_mm must be an integer'));
  assert.ok(!any(withFoundations, 'datum_table.rules.footing'));
});

// ---- validator: aligned CAD source and insets ----------------------------------------------------------------------
const cad = (m) => m.sources.find((s) => s.role === 'aligned_cad');

test('aligned_cad source: scale 1, anchors within 1 mm, confirmed layer map, pinned and registered', () => {
  assert.ok(any(errorsFor((m) => { cad(m).cad.scale = 0.001; }), 'cad.scale must be 1'));
  assert.ok(any(errorsFor((m) => { cad(m).cad.anchor_checks[0].deviation_mm = 3; }), 'not aligned'));
  assert.ok(any(errorsFor((m) => { cad(m).cad.anchor_checks = []; }), 'anchor_checks'));
  assert.ok(any(errorsFor((m) => { cad(m).cad.layer_map = {}; }), 'layer_map'));
  assert.ok(any(errorsFor((m) => { delete cad(m).cad; }), 'cad must be an object'));
  assert.ok(any(errorsFor((m) => { cad(m).pinned_expected = false; }), 'pinned and immutable'));
  assert.ok(any(errorsFor((m) => { cad(m).registered_in_revit = false; }), 'must be registered in Revit'));
  assert.ok(any(errorsFor((m) => { cad(m).role = 'dwg'; }), "'aligned_cad'"));
  assert.ok(any(errorsFor((m) => { m.sources.push({...structuredClone(m.sources[0]), source_id: 'x'}); }), 'exactly one primary'));
});

test('insets need two matched grid intersections and a transform', () => {
  assert.ok(any(errorsFor((m) => { m.coordinate_basis.insets[0].matched_grid_intersections.pop(); }), 'at least 2 matches'));
  assert.ok(any(errorsFor((m) => { delete m.coordinate_basis.insets[0].transform_to_model; }), 'transform_to_model'));
  assert.ok(any(errorsFor((m) => { m.coordinate_basis.insets[0].matched_grid_intersections[0].grid_y = ''; }), 'matched_grid_intersections[0]'));
});

// ---- validator: snapped columns ------------------------------------------------------------------------------------
test('snapped column evidence: XY equals the intersection; CAD deviation is checked against the tolerance', () => {
  assert.deepEqual(validateManifest(manifest()), []);
  assert.ok(any(errorsFor((m) => { row(m, COL1).geometry_mm.x = 12; }), 'must equal the grid intersection'));
  const far = errorsFor((m) => { Object.assign(row(m, COL1).snap, {cad_mm: [400, 0], deviation_mm: 400}); });
  assert.ok(any(far, 'wrong match, do not snap'));
  assert.ok(any(errorsFor((m) => { row(m, COL1).snap.deviation_mm = 2; }), 'does not match cad_mm'));
  // a wider tolerance, stated by the human, accepts the same deviation
  assert.deepEqual(errorsFor((m) => {
    Object.assign(row(m, COL1).snap, {cad_mm: [80, 0], deviation_mm: 80});
    m.acceptance_tests.snap_tolerance_mm = 100;
  }), []);
  assert.ok(any(errorsFor((m) => { Object.assign(row(m, COL1).snap, {cad_mm: [80, 0], deviation_mm: 80}); }), 'max 50'));
  assert.ok(any(errorsFor((m) => { delete row(m, COL1).snap.grid_x; }), 'snap must be'));
  // blocked rows are not policed
  assert.deepEqual(errorsFor((m) => {
    Object.assign(row(m, COL1), {status: 'blocked', execution_action: 'none'});
    Object.assign(row(m, COL1).snap, {cad_mm: [400, 0], deviation_mm: 400});
    m.acceptance_tests.expected_counts.structural_columns = 1;
  }), []);
});

// ---- compiler ------------------------------------------------------------------------------------------------------
test('compile: floor stage follows walls; floor and architectural wall payloads are exact', () => {
  const r = compileBuildPayloads(manifest());
  assert.deepEqual(r.payloads.map((p) => p.stage), ['grid', 'column', 'wall', 'floor']);
  assert.deepEqual(r.counts, {grid: 4, footing: 0, column: 2, beam: 0, wall: 1, floor: 1});
  assert.deepEqual(r.payloads[2].payload.elements[0], {
    sourceKey: 'ARQ-01/W/001', kind: 'wall', familyName: 'Basic Wall', typeName: 'Generico - 200',
    start: {x: 0, y: 0}, end: {x: 20000, y: 0}, baseLevel: 'Nivel 1', baseOffsetMm: 0,
    structural: false, locationLine: 'center', topLevel: 'Nivel 2', topOffsetMm: 0,
  });
  assert.deepEqual(r.payloads[3].payload.elements[0], {
    sourceKey: 'ARQ-01/L/001', kind: 'floor', typeName: 'Generico 150', level: 'Nivel 1', offsetMm: 0, structural: false,
    boundary: [
      [{x: 0, y: 0}, {x: 20000, y: 0}, {x: 20000, y: 8000}, {x: 0, y: 8000}],
      [{x: 5000, y: 2000}, {x: 7000, y: 2000}, {x: 7000, y: 4000}, {x: 5000, y: 4000}],
    ],
  });
});

test('compile: architectural walls are always structural false; structural_floors floors default to structural true', () => {
  const m = manifest();
  delete row(m, 'ARQ-01/W/001').structural;
  assert.equal(compileBuildPayloads(m).payloads[2].payload.elements[0].structural, false);
  const s = manifest();
  s.scope.categories.push('structural_floors');
  s.type_manifest.push({...structuredClone(s.type_manifest[2]), source_key: 'ARQ-01/T/SF', category: 'structural_floors'});
  s.element_manifest.push({...structuredClone(row(s, FLOOR)), source_key: 'ARQ-01/SL/001', category: 'structural_floors', type_key: 'ARQ-01/T/SF'});
  s.acceptance_tests.expected_counts.structural_floors = 1;
  const floors = compileBuildPayloads(s).payloads[3].payload.elements;
  assert.deepEqual(floors.map((e) => [e.sourceKey, e.structural]), [['ARQ-01/L/001', false], ['ARQ-01/SL/001', true]]);
});

test('compile: levels are not build_elements rows; created levels go to levelsToCreate sorted by elevation', () => {
  const r = compileBuildPayloads(manifest());
  assert.deepEqual(r.levelsToCreate, [
    {name: 'Nivel -2', elevation: -8000}, {name: 'Nivel -1', elevation: -4500}, {name: 'Nivel 2', elevation: 5500},
  ]);
  assert.ok(r.payloads.every((p) => p.payload.elements.every((e) => e.kind !== 'level')));
  const none = manifest();
  for (const l of none.levels) l.action = 'existing';
  assert.deepEqual(compileBuildPayloads(none).levelsToCreate, []);
});

test('compile CLI writes levels_to_create.json and the floor payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  const lines = [];
  assert.equal(main([join(DIR, 'manifest.json'), '--out-dir', dir], (l) => lines.push(l)), 0);
  assert.deepEqual(readdirSync(dir).sort(), [
    'build_payload_001_grid.json', 'build_payload_002_column.json', 'build_payload_003_wall.json',
    'build_payload_004_floor.json', 'compile_summary.json', 'levels_to_create.json',
  ]);
  const levels = JSON.parse(readFileSync(join(dir, 'levels_to_create.json'), 'utf8'));
  assert.equal(levels.tool, 'create_level');
  assert.equal(levels.manifestHash, JSON.parse(lines[0]).manifestHash);
  assert.deepEqual(levels.data.map((l) => l.name), ['Nivel -2', 'Nivel -1', 'Nivel 2']);
  assert.deepEqual(JSON.parse(lines[0]).levelsToCreate, {file: 'levels_to_create.json', count: 3});
});

// ---- QA ------------------------------------------------------------------------------------------------------------
const qa = (mutate) => {
  const m = manifest();
  const r = readback();
  mutate?.(m, r);
  return runQa(m, r);
};
const failed = (report, check) => report.failures.filter((f) => f.check === check);
const item = (r, key) => r.items.find((i) => i.sourceKey === key);

test('QA passes on the architectural fixture (floor, wall, level-to-level columns, no foundations)', () => {
  const report = qa();
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  const checks = new Set(report.rows.map((x) => x.check));
  for (const c of ['boundary_bbox', 'area', 'z_top', 'level_span', 'z_base', 'xy']) assert.ok(checks.has(c), c);
  assert.ok(report.rows.some((x) => x.check === 'support' && x.status === 'skip'));
});

test('QA floor: top z, boundary bbox and area are compared', () => {
  assert.equal(failed(qa((m, r) => { item(r, FLOOR).bbox.max[2] = 5; }), 'z_top').length, 1);
  assert.equal(failed(qa((m, r) => { item(r, FLOOR).bbox.max[0] += 10; }), 'boundary_bbox').length, 1);
  assert.equal(failed(qa((m, r) => { item(r, FLOOR).areaMm2 *= 1.02; }), 'area').length, 1);
  assert.equal(failed(qa((m, r) => { delete item(r, FLOOR).areaMm2; }), 'area').length, 0); // area only when available
  assert.equal(failed(qa((m) => { row(m, FLOOR).z_constraints.offset_mm = 20; }), 'z_top').length, 1);
  // the transform is applied to the boundary
  assert.equal(failed(qa((m) => { m.coordinate_basis.transform_to_model.originMm.x = 0; }), 'boundary_bbox').length, 1);
});

test('QA architectural wall: xy and category (built-in Revit alias) are checked like a wall', () => {
  assert.equal(failed(qa((m, r) => { item(r, 'ARQ-01/W/001').location.end[0] += 30; }), 'xy').length, 1);
  assert.equal(failed(qa((m, r) => { item(r, 'ARQ-01/W/001').category = 'Doors'; }), 'category').length, 1);
});

test('QA level-to-level columns: base/top levels must match; missing readback levels warn', () => {
  assert.equal(failed(qa((m, r) => { item(r, COL1).offsets.topLevel = 'Nivel 1'; }), 'level_span').length, 1);
  const r = qa((m, rb) => { delete item(rb, COL1).offsets; });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.check === 'level_span'));
  assert.equal(failed(qa((m, rb) => { item(rb, COL1).bbox.max[2] = 4000; }), 'z_top').length, 1);
});

test('QA support check still applies when foundations are in scope', () => {
  const report = qa((m) => { m.scope.categories.push('structural_foundations'); });
  assert.ok(failed(report, 'support').length >= 1);
});
