// Original to this repository. Tests parking / generic_families rows compiling to build_elements kind 'family'.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileBuildPayloads} from './compile_build_payload.mjs';
import {validateManifest} from './validate_manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'tests', 's301-synthetic', 'manifest.json');

function manifest() {
  const m = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  m.scope.categories.push('parking');
  m.type_manifest.push({
    source_key: 'S301/T/PARK', category: 'parking', status: 'resolved', family: 'Plaza de aparcamiento 2D',
    type: '5000x2500', dimensions_mm: {length: 5000, width: 2500}, material: 'n/a', action: 'reuse',
    revit_category: 'OST_Parking', evidence: [{sheet: '1725-S301', detail: 'synthetic'}],
  });
  m.element_manifest.push({
    source_key: 'S301/P/001', category: 'parking', status: 'resolved', type_key: 'S301/T/PARK', execution_action: 'create',
    geometry_mm: {x: 3000, y: 4000, rotation_deg: 90}, z_constraints: {level: 'NPT', offset_mm: 0}, evidence: [{sheet: '1725-S301', detail: 'synthetic'}],
  });
  m.acceptance_tests.expected_counts.parking = 1;
  return m;
}
const rowOf = (m) => m.element_manifest.find((r) => r.source_key === 'S301/P/001');

test('parking row compiles to kind family with the type revit_category', () => {
  const r = compileBuildPayloads(manifest());
  const fam = r.payloads.find((p) => p.stage === 'family');
  assert.deepEqual(fam.payload.elements, [{
    sourceKey: 'S301/P/001', kind: 'family', familyName: 'Plaza de aparcamiento 2D', typeName: '5000x2500',
    point: {x: 3000, y: 4000}, rotationDeg: 90, level: 'NPT', offsetMm: 0, category: 'OST_Parking',
  }]);
});

test('parking rows need integer x/y, rotation, level and integer offset_mm', () => {
  const a = manifest();
  delete rowOf(a).z_constraints.offset_mm;
  assert.ok(validateManifest(a).some((e) => e.includes('z_constraints.offset_mm')));
  const b = manifest();
  rowOf(b).geometry_mm.x = 1.5;
  assert.ok(validateManifest(b).some((e) => e.includes('geometry_mm.x/y')));
});

test('generic_families is an allowed category mapped to kind family', () => {
  const m = manifest();
  rowOf(m).category = 'generic_families';
  m.scope.categories.push('generic_families');
  m.acceptance_tests.expected_counts = {...m.acceptance_tests.expected_counts, parking: 0, generic_families: 1};
  m.type_manifest.find((t) => t.source_key === 'S301/T/PARK').category = 'generic_families';
  assert.deepEqual(validateManifest(m), []);
});
