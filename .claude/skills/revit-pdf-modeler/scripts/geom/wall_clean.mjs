#!/usr/bin/env node
// Wall / loop cleaning so Revit accepts the geometry without "slightly off axis" warnings.
//
// WHY (lessons from a live run):
//  - Revit warns "wall slightly off axis" for walls even 0.0001 deg away from 0/45/90/135 deg.
//    Edges near those angles must be made exact.
//  - With integer-mm endpoints, a diagonal is exactly 45/135 deg iff |dx| == |dy|. So diagonals are
//    solved on the lines x+y=const / y-x=const and rounded with that relation preserved (exactInteger).
//  - Rounding each polygon independently (slab/floor boundaries) shifts shared vertices by different
//    amounts and creates ~0.02 m2 overlaps/gaps between neighbouring slabs. Snap ALL loops globally
//    (snapLoopsGlobal) so shared vertices move together.
//  - Overlapping collinear walls and T-junction ends that stop short of the host wall make Revit
//    auto-join move endpoints or fail; merge collinear and project T ends (cleanWalls/mergeCollinear).
//
// Segments are [[x0,y0],[x1,y1]] in mm. CLI:
//   node wall_clean.mjs walls.json --out clean.json [--tol 40] [--ang 2] [--min-len 100] [--merge-parallel 300]
// walls.json is an array of segments or an object { <level>: segments }.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const D2R = 180 / Math.PI;
const dang = (a, b) => (((Math.atan2(b[1] - a[1], b[0] - a[0]) * D2R) + 360) % 180);
const segLen = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function kindOfAngle(th, angDeg) {
  if (th < angDeg || th > 180 - angDeg) return 'y'; // horizontal: equal y
  if (Math.abs(th - 90) < angDeg) return 'x';       // vertical: equal x
  if (Math.abs(th - 45) < angDeg) return 'd';       // 45 deg: y-x const
  if (Math.abs(th - 135) < angDeg) return 's';      // 135 deg: x+y const
  return null;
}

function unionFind(n) {
  const p = [...Array(n).keys()];
  const f = (i) => (p[i] === i ? i : (p[i] = f(p[i])));
  return { f, u: (a, b) => { p[f(a)] = f(b); } };
}

function groupsOf(U, n) {
  const out = {};
  for (const k of ['x', 'y', 's', 'd']) {
    const g = new Map();
    for (let i = 0; i < n; i++) { const r = U[k].f(i); (g.get(r) || g.set(r, []).get(r)).push(i); }
    out[k] = [...g.values()].filter((a) => a.length > 1);
  }
  return out;
}

// iterative projection onto the equality constraints; roundAxis=true keeps x/y group values integer
function project(P, G, iters, roundAxis) {
  const rnd = roundAxis ? Math.round : (v) => v;
  for (let it = 0; it < iters; it++) {
    for (const g of G.x) { const m = rnd(g.reduce((t, i) => t + P[i][0], 0) / g.length); for (const i of g) P[i][0] = m; }
    for (const g of G.y) { const m = rnd(g.reduce((t, i) => t + P[i][1], 0) / g.length); for (const i of g) P[i][1] = m; }
    for (const g of G.s) { const m = g.reduce((t, i) => t + P[i][0] + P[i][1], 0) / g.length; for (const i of g) { const dl = (m - P[i][0] - P[i][1]) / 2; P[i][0] += dl; P[i][1] += dl; } }
    for (const g of G.d) { const m = g.reduce((t, i) => t + P[i][1] - P[i][0], 0) / g.length; for (const i of g) { const dl = (m - (P[i][1] - P[i][0])) / 2; P[i][1] += dl; P[i][0] -= dl; } }
  }
}

// integer rounding that keeps diagonal relations: pick integer s/d per group, solve the free coordinate
function roundDiagonals(R, G) {
  const inX = new Set(G.x.flat()), inY = new Set(G.y.flat());
  for (const k of ['s', 'd']) for (const g of G[k]) {
    const m = Math.round(g.reduce((t, i) => t + (k === 's' ? R[i][0] + R[i][1] : R[i][1] - R[i][0]), 0) / g.length);
    for (const i of g) {
      if (k === 's') { if (inY.has(i) && !inX.has(i)) R[i][0] = m - R[i][1]; else R[i][1] = m - R[i][0]; }
      else { if (inY.has(i) && !inX.has(i)) R[i][0] = R[i][1] - m; else R[i][1] = m + R[i][0]; }
    }
  }
}

/**
 * Clean wall centerlines: shared vertices (endpoints within tol merge), near-axis edges (within angDeg of
 * 0/45/90/135) constrained exact via constraint groups, T-junction ends projected onto the host wall.
 * Output is float (exact relations); call exactInteger afterwards.
 */
export function cleanWalls(segs, { angDeg = 2.0, tol = 40, iters = 200, minLen = 100 } = {}) {
  const V = [], E = [], cellMap = new Map();
  const key = (cx, cy) => cx + ',' + cy;
  const vid = (p) => {
    const cx = Math.floor(p[0] / tol), cy = Math.floor(p[1] / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of cellMap.get(key(cx + dx, cy + dy)) || []) {
        if (Math.hypot(V[i][0] - p[0], V[i][1] - p[1]) < tol) {
          V[i].n++; V[i][0] += (p[0] - V[i][0]) / V[i].n; V[i][1] += (p[1] - V[i][1]) / V[i].n;
          return i;
        }
      }
    }
    const v = [p[0], p[1]]; v.n = 1; V.push(v);
    (cellMap.get(key(cx, cy)) || cellMap.set(key(cx, cy), []).get(key(cx, cy))).push(V.length - 1);
    return V.length - 1;
  };
  for (const [a, b] of segs) { const i = vid(a), j = vid(b); if (i !== j) E.push([i, j]); }
  const U = { x: unionFind(V.length), y: unionFind(V.length), s: unionFind(V.length), d: unionFind(V.length) };
  for (const [i, j] of E) { const k = kindOfAngle(dang(V[i], V[j]), angDeg); if (k) U[k].u(i, j); }
  const P = V.map((v) => [v[0], v[1]]);
  project(P, groupsOf(U, P.length), iters, false);
  // T-junctions: a free end (degree 1) near another edge's interior slides along its own direction onto that edge
  const deg = new Array(P.length).fill(0);
  for (const [i, j] of E) { deg[i]++; deg[j]++; }
  for (let v = 0; v < P.length; v++) {
    if (deg[v] !== 1) continue;
    const own = E.find(([x, y]) => x === v || y === v);
    const o = P[own[0] === v ? own[1] : own[0]];
    const dir = [P[v][0] - o[0], P[v][1] - o[1]];
    for (const [i, j] of E) {
      if (i === v || j === v) continue;
      const a = P[i], b = P[j], r = [b[0] - a[0], b[1] - a[1]], L2 = r[0] * r[0] + r[1] * r[1], L = Math.sqrt(L2);
      const t = ((P[v][0] - a[0]) * r[0] + (P[v][1] - a[1]) * r[1]) / L2;
      const q = [a[0] + t * r[0], a[1] + t * r[1]], d = Math.hypot(q[0] - P[v][0], q[1] - P[v][1]);
      if (!(t * L > tol && (1 - t) * L > tol && d < tol && d > 0.5)) continue;
      const den = dir[0] * r[1] - dir[1] * r[0];
      if (Math.abs(den) < 1e-9) { P[v] = q; break; }
      const k = ((a[0] - o[0]) * r[1] - (a[1] - o[1]) * r[0]) / den;
      P[v] = [o[0] + k * dir[0], o[1] + k * dir[1]];
      break;
    }
  }
  return E.map(([i, j]) => [P[i], P[j]]).filter((s) => segLen(s) >= minLen);
}

/** Near-axis but not exact (within maxDeg of 0/45/90/135, off by more than 1e-4 deg): what Revit warns about. */
export function offAxis(segs, maxDeg = 2) {
  return segs.filter(([a, b]) => {
    const th = dang(a, b);
    const d = Math.min(th, 180 - th, Math.abs(th - 90), Math.abs(th - 45), Math.abs(th - 135));
    return d > 1e-4 && d <= maxDeg;
  });
}

/** Merge collinear overlapping/touching segments (exact after snapping) so Revit sees no overlapping walls. */
export function mergeCollinear(segs, angTol = 1e-4, offTol = 1, gap = 1) {
  const groups = [];
  for (const [a, b] of segs) {
    let th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-12) th -= Math.PI;
    const n = [-Math.sin(th), Math.cos(th)], d = [Math.cos(th), Math.sin(th)], off = a[0] * n[0] + a[1] * n[1];
    let g = groups.find((g) => Math.abs(g.th - th) < angTol && Math.abs(g.off - off) < offTol);
    if (!g) { g = { th, off, n, d, iv: [], ref: a }; groups.push(g); }
    const t = (p) => (p[0] - g.ref[0]) * g.d[0] + (p[1] - g.ref[1]) * g.d[1];
    g.iv.push(t(a) < t(b) ? [t(a), t(b), a, b] : [t(b), t(a), b, a]);
  }
  const out = [];
  for (const g of groups) {
    g.iv.sort((x, y) => x[0] - y[0]);
    let cur = null;
    for (const iv of g.iv) {
      if (cur && iv[0] <= cur[1] + gap) { if (iv[1] > cur[1]) { cur[1] = iv[1]; cur[3] = iv[3]; } }
      else { if (cur) out.push([cur[2], cur[3]]); cur = [...iv]; }
    }
    if (cur) out.push([cur[2], cur[3]]);
  }
  return out;
}

/**
 * Loose collinear de-duplication for noisy sources (PDF/CAD with doubled lines): groups segments whose
 * angle differs < angTol (rad) and offset < offTol (mm), merges intervals separated by <= gap, and
 * re-emits them on the group line with integer endpoints. Drops results shorter than minLen.
 */
export function dedupeLines(segs, { angTol = 0.01, offTol = 40, gap = 60, minLen = 200 } = {}) {
  const groups = [];
  for (const [a, b] of segs) {
    let th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-9) th -= Math.PI;
    const n = [-Math.sin(th), Math.cos(th)], d = [Math.cos(th), Math.sin(th)], off = a[0] * n[0] + a[1] * n[1];
    let g = groups.find((g) => Math.abs(g.th - th) < angTol && Math.abs(g.off - off) < offTol);
    if (!g) { g = { th, off, n, d, iv: [] }; groups.push(g); }
    const ta = a[0] * d[0] + a[1] * d[1], tb = b[0] * d[0] + b[1] * d[1];
    g.iv.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }
  const out = [];
  for (const g of groups) {
    g.iv.sort((x, y) => x[0] - y[0]);
    let cur = null;
    const emit = () => out.push(cur.map((t) => [Math.round(g.d[0] * t + g.n[0] * g.off), Math.round(g.d[1] * t + g.n[1] * g.off)]));
    for (const iv of g.iv) { if (cur && iv[0] <= cur[1] + gap) cur[1] = Math.max(cur[1], iv[1]); else { if (cur) emit(); cur = [...iv]; } }
    if (cur) emit();
  }
  return out.filter((s) => segLen(s) >= minLen);
}

/** Merge parallel overlapping segments whose offsets differ <= offTol (multi-edge wall bands) into one at the length-weighted mean offset. */
export function mergeParallel(segs, offTol = 300, angTol = 0.01) {
  const S = segs.map(([a, b]) => {
    let th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-12) th -= Math.PI;
    const n = [-Math.sin(th), Math.cos(th)], d = [Math.cos(th), Math.sin(th)];
    const t0 = a[0] * d[0] + a[1] * d[1], t1 = b[0] * d[0] + b[1] * d[1];
    return { th, n, d, off: a[0] * n[0] + a[1] * n[1], lo: Math.min(t0, t1), hi: Math.max(t0, t1), L: Math.abs(t1 - t0), used: false };
  });
  const out = [];
  for (let i = 0; i < S.length; i++) {
    if (S[i].used) continue;
    const grp = [S[i]];
    S[i].used = true;
    for (let grew = true; grew;) {
      grew = false;
      for (const s of S) {
        if (s.used) continue;
        if (grp.some((g) => Math.abs(g.th - s.th) < angTol && Math.abs(g.off - s.off) <= offTol && Math.min(g.hi, s.hi) - Math.max(g.lo, s.lo) > 0)) { grp.push(s); s.used = true; grew = true; }
      }
    }
    const W = grp.reduce((t, g) => t + g.L, 0);
    const off = grp.reduce((t, g) => t + g.off * g.L, 0) / W;
    const lo = Math.min(...grp.map((g) => g.lo)), hi = Math.max(...grp.map((g) => g.hi)), g0 = grp[0];
    out.push([[g0.d[0] * lo + g0.n[0] * off, g0.d[1] * lo + g0.n[1] * off], [g0.d[0] * hi + g0.n[0] * off, g0.d[1] * hi + g0.n[1] * off]]);
  }
  return out;
}

/** Integer endpoints with exact axis relations per wall: orthogonal walls share one coordinate, diagonals get |dx| == |dy|. */
export function exactInteger(segs, { angDeg = 2.0, minLen = 100 } = {}) {
  const ang = typeof angDeg === 'number' ? angDeg : 2.0;
  return segs.map(([a, b]) => {
    const A = a.map(Math.round), B = b.map(Math.round);
    const th = dang(A, B);
    if (th < ang || th > 180 - ang) { const y = Math.round((A[1] + B[1]) / 2); return [[A[0], y], [B[0], y]]; }
    if (Math.abs(th - 90) < ang) { const x = Math.round((A[0] + B[0]) / 2); return [[x, A[1]], [x, B[1]]]; }
    if (Math.abs(th - 45) < ang || Math.abs(th - 135) < ang) {
      const dx = B[0] - A[0], dy = B[1] - A[1], m = Math.round((Math.abs(dx) + Math.abs(dy)) / 2);
      return [A, [A[0] + Math.sign(dx) * m, A[1] + Math.sign(dy) * m]];
    }
    return [A, B];
  }).filter((s) => segLen(s) >= minLen);
}

/**
 * Snap many closed loops together (slab/room boundaries): vertices within tol (mm) become ONE vertex,
 * near-axis edges are made exact, output is integer mm, consecutive duplicates removed.
 * Doing this globally (not per polygon) keeps shared boundaries identical so neighbouring slabs do not overlap.
 */
export function snapLoopsGlobal(loops, { tol = 30, angDeg = 2.0, iters = 300 } = {}) {
  const V = [];
  const idx = loops.map((l) => l.map((p) => {
    for (let i = 0; i < V.length; i++) if (Math.hypot(V[i][0] - p[0], V[i][1] - p[1]) < tol) return i;
    V.push([p[0], p[1]]);
    return V.length - 1;
  }));
  const n = V.length;
  const U = { x: unionFind(n), y: unionFind(n), s: unionFind(n), d: unionFind(n) };
  for (const l of idx) for (let k = 0; k < l.length; k++) {
    const i = l[k], j = l[(k + 1) % l.length];
    if (i === j) continue;
    const t = kindOfAngle(dang(V[i], V[j]), angDeg);
    if (t) U[t].u(i, j);
  }
  const G = groupsOf(U, n);
  const P = V.map((v) => [...v]);
  project(P, G, iters, true);
  const R = P.map((p) => [Math.round(p[0]), Math.round(p[1])]);
  roundDiagonals(R, G);
  return idx.map((l) => {
    const out = [];
    for (const i of l) { const p = R[i], q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); }
    if (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
    return out;
  });
}

/** Single-loop convenience wrapper around snapLoopsGlobal. */
export function snapLoop(loop, opts = {}) {
  return snapLoopsGlobal([loop], { tol: 0.5, ...opts })[0];
}

function dpOpen(P, eps) {
  if (P.length < 3) return P;
  const a = P[0], b = P.at(-1);
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  let imax = 0, dmax = -1;
  for (let i = 1; i < P.length - 1; i++) {
    const d = L < 1e-9 ? Math.hypot(P[i][0] - a[0], P[i][1] - a[1]) : Math.abs((P[i][0] - a[0]) * dy - (P[i][1] - a[1]) * dx) / L;
    if (d > dmax) { dmax = d; imax = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...dpOpen(P.slice(0, imax + 1), eps).slice(0, -1), ...dpOpen(P.slice(imax), eps)];
}

/** Douglas-Peucker simplification of a polyline (open). */
export function simplifyPolyline(P, eps) { return dpOpen(P, eps); }

/** Douglas-Peucker simplification of a closed ring (no repeated closing point in/out). Splits at the two most distant vertices. */
export function simplifyRing(ring, eps) {
  if (ring.length <= 3) return ring;
  let i0 = 0, best = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > best) { best = d; i0 = i; } }
  const A = dpOpen(ring.slice(0, i0 + 1), eps), B = dpOpen([...ring.slice(i0), ring[0]], eps);
  const out = [...A.slice(0, -1), ...B.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/** Full pipeline used in the live run: cleanWalls -> mergeCollinear -> exactInteger -> mergeCollinear. */
export function cleanPipeline(segs, opts = {}) {
  const { tol = 40, angDeg = 2.0, minLen = 100, mergeParallelMm = 0 } = opts;
  let s = segs;
  if (mergeParallelMm > 0) s = mergeParallel(s, mergeParallelMm);
  s = cleanWalls(s, { tol, angDeg, minLen });
  s = exactInteger(mergeCollinear(s, 1e-4, 1, 1), { angDeg, minLen });
  return mergeCollinear(s, 1e-12, 0.5, 1);
}

function cli(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; } }
    else a._.push(argv[i]);
  }
  return a;
}

function main() {
  const a = cli(process.argv.slice(2));
  if (!a._[0] || a.help) {
    console.error('usage: wall_clean.mjs <walls.json> [--out clean.json] [--tol 40] [--ang 2] [--min-len 100] [--merge-parallel mm]');
    process.exit(a.help ? 0 : 2);
  }
  const data = JSON.parse(fs.readFileSync(a._[0], 'utf8'));
  const opts = { tol: Number(a.tol ?? 40), angDeg: Number(a.ang ?? 2), minLen: Number(a['min-len'] ?? 100), mergeParallelMm: Number(a['merge-parallel'] ?? 0) };
  const sets = Array.isArray(data) ? { all: data } : data;
  const out = {}, report = {};
  for (const [k, segs] of Object.entries(sets)) {
    out[k] = cleanPipeline(segs, opts);
    report[k] = { in: segs.length, out: out[k].length, off_axis_after: offAxis(out[k], opts.angDeg).length };
  }
  const result = Array.isArray(data) ? out.all : out;
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(result));
  console.log(JSON.stringify({ report, ...(a.out ? { out: a.out } : { result }) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
