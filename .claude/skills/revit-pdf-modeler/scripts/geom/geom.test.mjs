import test from 'node:test';
import assert from 'node:assert/strict';
import { arcPoints, circleFrom3 } from './arc.mjs';
import { itemsToSegments, planarFaces, addHoles, cleanPinch } from './planar_faces.mjs';
import {
  cleanWalls, exactInteger, offAxis, mergeCollinear, mergeParallel, dedupeLines,
  snapLoopsGlobal, simplifyRing, cleanPipeline,
} from './wall_clean.mjs';
import { loadPolygonClipping } from './pc.mjs';

const L = (a, b, layer = 'W') => ({ k: 'l', L: layer, a, b });

test('arcPoints: 3-point arc keeps endpoints and radius, picks the side through m', () => {
  const pts = arcPoints({ a: [1000, 0], m: [0, 1000], b: [-1000, 0] }, 300);
  assert.deepEqual(pts[0], [1000, 0]);
  assert.deepEqual(pts.at(-1), [-1000, 0]);
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 1000) < 1e-6);
  assert.ok(pts.some((p) => p[1] > 900), 'goes through the top');
  // reversed mid point -> goes through the bottom
  const down = arcPoints({ a: [1000, 0], m: [0, -1000], b: [-1000, 0] }, 300);
  assert.ok(down.some((p) => p[1] < -900));
  // with explicit c/r, same result
  const withC = arcPoints({ c: [0, 0], r: 1000, a: [1000, 0], m: [0, 1000], b: [-1000, 0] }, 300);
  assert.equal(withC.length, pts.length);
  assert.ok(circleFrom3([1, 0], [0, 1], [-1, 0]).r > 0.999);
});

test('planar faces: 2 rooms sharing a wall that ends in T junctions; dangling stub pruned', () => {
  const items = [
    L([0, 0], [10000, 0]), L([10000, 0], [10000, 5000]), L([10000, 5000], [0, 5000]), L([0, 5000], [0, 0]),
    L([6000, 0], [6000, 5000]),           // shared wall, endpoints T onto long outer lines
    L([2000, 2000], [3000, 2000]),        // dangling stub
    L([0, 0], [1, 1], 'OTHER'),
  ];
  const segs = itemsToSegments(items, { layers: ['W'] });
  const faces = planarFaces(segs, { snap: 20, minArea: 1 });
  assert.equal(faces.length, 2);
  assert.deepEqual(faces.map((f) => f.area_m2), [30, 20]);
  assert.deepEqual([faces[0].cx, faces[0].cy], [3000, 2500]);
  assert.deepEqual([faces[1].cx, faces[1].cy], [8000, 2500]);
});

test('planar faces: crossing lines (X junction) split into 4 faces', () => {
  const items = [
    L([0, 0], [4000, 0]), L([4000, 0], [4000, 4000]), L([4000, 4000], [0, 4000]), L([0, 4000], [0, 0]),
    L([2000, 0], [2000, 4000]), L([0, 2000], [4000, 2000]),
  ];
  const faces = planarFaces(itemsToSegments(items), { minArea: 1 });
  assert.equal(faces.length, 4);
  assert.ok(faces.every((f) => f.area_m2 === 4));
});

test('planar faces: island loop becomes a hole (polygon difference)', async (t) => {
  if (!(await loadPolygonClipping())) return t.skip('polygon-clipping not installed');
  const rect = (x0, y0, x1, y1) => [L([x0, y0], [x1, y0]), L([x1, y0], [x1, y1]), L([x1, y1], [x0, y1]), L([x0, y1], [x0, y0])];
  const items = [...rect(0, 0, 10000, 10000), ...rect(4000, 4000, 6000, 6000)];
  const faces = await addHoles(planarFaces(itemsToSegments(items), { minArea: 1 }));
  assert.equal(faces.length, 2);
  const outer = faces.find((f) => f.gross_m2 === 100);
  assert.equal(outer.area_m2, 96);
  assert.equal(outer.holes.length, 1);
  assert.equal(faces.find((f) => f.gross_m2 === 4).holes.length, 0);
});

test('cleanPinch splits a figure-8 ring into two simple polygons', async (t) => {
  if (!(await loadPolygonClipping())) return t.skip('polygon-clipping not installed');
  const ring = [[0, 0], [1000, 0], [1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000], [1000, 1000], [0, 1000]]; // touches itself at (1000,1000)
  const parts = await cleanPinch(ring);
  const shoelace = (r) => Math.abs(r.reduce((a, q, k) => a + q[0] * r[(k + 1) % r.length][1] - r[(k + 1) % r.length][0] * q[1], 0)) / 2;
  const area = parts.reduce((s, p) => s + shoelace(p.outer) - p.holes.reduce((h, r) => h + shoelace(r), 0), 0);
  assert.equal(area, 2e6);
});

test('wall cleaning: a 44.99 deg wall becomes exactly 45 deg with |dx|==|dy|', () => {
  const walls = [[[0, 0], [10000, 9998]], [[0, 0], [0, -5000]], [[10000, 9998], [20000, 9998.4]]];
  assert.ok(offAxis(walls, 2).length >= 2);
  const out = cleanPipeline(walls, { tol: 40, angDeg: 2 });
  assert.equal(offAxis(out, 2).length, 0);
  const diag = out.find(([a, b]) => Math.abs(b[0] - a[0]) > 1000 && Math.abs(b[1] - a[1]) > 1000);
  assert.ok(diag);
  assert.equal(Math.abs(diag[1][0] - diag[0][0]), Math.abs(diag[1][1] - diag[0][1]));
  for (const s of out) for (const p of s) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
  // the horizontal wall is exactly horizontal and shares the diagonal's end vertex
  const hor = out.find(([a, b]) => a[1] === b[1] && Math.abs(b[0] - a[0]) > 5000);
  assert.ok(hor);
});

test('cleanWalls projects a short T end onto the host wall', () => {
  const host = [[0, 0], [10000, 0]];
  const stub = [[5000, 3000], [5000, 25]]; // stops 25 mm short of the host
  const out = cleanWalls([host, stub], { tol: 40 });
  const s = out.find(([a, b]) => Math.abs(a[0] - 5000) < 1 && Math.abs(b[0] - 5000) < 1);
  assert.ok(Math.abs(s[1][1]) < 1e-6);
});

test('mergeCollinear / dedupeLines / mergeParallel', () => {
  assert.equal(mergeCollinear([[[0, 0], [1000, 0]], [[900, 0], [2000, 0]], [[3000, 0], [4000, 0]]]).length, 2);
  const d = dedupeLines([[[0, 0], [3000, 0]], [[0, 20], [3000, 20]], [[3010, 5], [6000, 5]]], { offTol: 40, gap: 60 });
  assert.equal(d.length, 1);
  assert.equal(d[0][1][0] - d[0][0][0], 6000);
  const m = mergeParallel([[[0, 0], [4000, 0]], [[0, 200], [4000, 200]]], 300);
  assert.equal(m.length, 1);
  assert.ok(Math.abs(m[0][0][1] - 100) < 1e-6);
});

test('snapLoopsGlobal: neighbouring slabs share identical vertices and have no overlap', () => {
  const a = [[0, 0], [5000.4, 0.3], [5000.2, 4000.1], [0.2, 3999.8]];
  const b = [[5000.0, 0.0], [10000.3, 0.2], [10000, 4000.2], [4999.7, 4000.0]];
  const [A, B] = snapLoopsGlobal([a, b], { tol: 30 });
  assert.deepEqual(A[1], B[0]);
  assert.deepEqual(A[2], B[3]);
  // axis edges are exact
  assert.equal(A[0][1], A[1][1]);
  assert.equal(A[1][0], A[2][0]);
});

test('snapLoopsGlobal keeps a diagonal slab edge exact 45 deg', () => {
  const [A] = snapLoopsGlobal([[[0, 0], [5000, 0], [8000, 2999.7], [0, 2999.7]]], { tol: 30 });
  const e = [A[2][0] - A[1][0], A[2][1] - A[1][1]];
  assert.equal(Math.abs(e[0]), Math.abs(e[1]));
});

test('simplifyRing removes collinear noise but keeps corners', () => {
  const ring = [[0, 0], [2500, 3], [5000, 0], [5000, 2500], [5000, 5000], [2500, 5002], [0, 5000], [0, 2500]];
  const out = simplifyRing(ring, 10);
  assert.equal(out.length, 4);
});
