#!/usr/bin/env node
// Planar face tracing from CAD linework (get_cad_geometry JSON format).
//
//   node planar_faces.mjs cad.json --layers "LAYER A,LAYER B" --snap 20 --min-area 3 --holes --out faces.json
//
// Input: JSON array of items { k:"l", a, b, L } | { k:"a", c, r, a, m, b, L } | { k:"p", pts, L }.
// Pipeline: items -> segments (arcs tessellated) -> split at crossings and T-junctions
// -> prune dangling edges -> trace bounded faces (CCW) -> optional holes / pinch cleanup.
// All coordinates are in the input unit (mm); area_m2 assumes mm.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { arcPoints } from './arc.mjs';
import { requirePolygonClipping } from './pc.mjs';

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** get_cad_geometry items -> flat list of segments [a,b,layer]. Open and closed polylines are both walked; closed polygons are NOT auto-closed unless the data repeats the first point. */
export function itemsToSegments(items, { layers = null, maxChord = 600, minLen = 5 } = {}) {
  const want = layers ? new Set(layers) : null;
  const segs = [];
  for (const o of items) {
    if (want && !want.has(o.L)) continue;
    let P;
    if (o.k === 'l') P = [o.a, o.b];
    else if (o.k === 'a') P = arcPoints(o, maxChord);
    else if (o.k === 'p') P = o.pts;
    else continue;
    for (let i = 0; i + 1 < P.length; i++) segs.push([P[i], P[i + 1], o.L]);
    if (o.k === 'p' && o.closed && P.length > 2) segs.push([P[P.length - 1], P[0], o.L]);
  }
  return segs.filter(([a, b]) => dist(a, b) > minLen);
}

function intersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [t, u];
}

/** Cut parameters per segment for proper crossings and T-junctions (endpoint within tTol of another segment's interior). */
export function splitParams(segs, { tTol = 25, cell = 4000 } = {}) {
  const cuts = segs.map(() => []);
  const grid = new Map();
  const cellsOf = ([a, b]) => {
    const x0 = Math.floor((Math.min(a[0], b[0]) - tTol) / cell), x1 = Math.floor((Math.max(a[0], b[0]) + tTol) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - tTol) / cell), y1 = Math.floor((Math.max(a[1], b[1]) + tTol) / cell);
    const out = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(x + ',' + y);
    return out;
  };
  segs.forEach((s, i) => { for (const k of cellsOf(s)) (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const seen = new Set();
  const N = segs.length;
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
      const key = i * N + j;
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = segs[i], [c, d] = segs[j];
      const X = intersect(a, b, c, d);
      if (X) { cuts[i].push(X[0]); cuts[j].push(X[1]); continue; }
      for (const [p, k, q1, q2] of [[c, i, a, b], [d, i, a, b], [a, j, c, d], [b, j, c, d]]) {
        const r = [q2[0] - q1[0], q2[1] - q1[1]], L2 = r[0] * r[0] + r[1] * r[1];
        const t = ((p[0] - q1[0]) * r[0] + (p[1] - q1[1]) * r[1]) / L2;
        if (t <= 0 || t >= 1) continue;
        const pr = [q1[0] + t * r[0], q1[1] + t * r[1]];
        if (dist(pr, p) < tTol) cuts[k].push(t);
      }
    }
  }
  return cuts;
}

/** Build the planar graph: unique vertices (snapped), unique edges, dangling edges pruned. */
export function buildGraph(segs, { snap = 20, tTol = 25 } = {}) {
  const cuts = splitParams(segs, { tTol });
  const vmap = new Map(), verts = [];
  const vid = (p) => {
    const cx = Math.round(p[0] / snap), cy = Math.round(p[1] / snap);
    for (const dx of [0, -1, 1]) for (const dy of [0, -1, 1]) {
      const id = vmap.get((cx + dx) + ',' + (cy + dy));
      if (id !== undefined && dist(verts[id], p) < snap) return id;
    }
    vmap.set(cx + ',' + cy, verts.length);
    verts.push([p[0], p[1]]);
    return verts.length - 1;
  };
  const edgeSet = new Set();
  let E = [];
  segs.forEach(([a, b], i) => {
    const ts = [0, 1, ...cuts[i]].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-6) continue;
      const p = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const q = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      const u = vid(p), v = vid(q);
      if (u === v) continue;
      const key = u < v ? u + '-' + v : v + '-' + u;
      if (!edgeSet.has(key)) { edgeSet.add(key); E.push([u, v]); }
    }
  });
  // iteratively drop dangling edges (degree-1 endpoints)
  for (;;) {
    const deg = new Map();
    for (const [u, v] of E) { deg.set(u, (deg.get(u) || 0) + 1); deg.set(v, (deg.get(v) || 0) + 1); }
    const next = E.filter(([u, v]) => deg.get(u) > 1 && deg.get(v) > 1);
    if (next.length === E.length) break;
    E = next;
  }
  return { verts, edges: E };
}

const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };

export function ringCentroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Trace bounded faces (CCW rings) of the planar graph. */
export function traceFaces({ verts, edges }, { minArea = 3 } = {}) {
  const out = new Map();
  for (const [u, v] of edges) {
    (out.get(u) || out.set(u, []).get(u)).push(v);
    (out.get(v) || out.set(v, []).get(v)).push(u);
  }
  const angle = (u, v) => Math.atan2(verts[v][1] - verts[u][1], verts[v][0] - verts[u][0]);
  for (const [u, ns] of out) ns.sort((a, b) => angle(u, a) - angle(u, b));
  const used = new Set();
  const faces = [];
  for (const [u0, v0] of edges) for (const [u, v] of [[u0, v0], [v0, u0]]) {
    if (used.has(u + '>' + v)) continue;
    const ring = [];
    let a = u, b = v, guard = 0;
    while (!used.has(a + '>' + b) && guard++ < 100000) {
      used.add(a + '>' + b);
      ring.push(a);
      const ns = out.get(b), i = ns.indexOf(a);
      const nxt = ns[(i - 1 + ns.length) % ns.length];
      a = b; b = nxt;
    }
    if (ring.length >= 3) faces.push(ring);
  }
  const res = [];
  for (const f of faces) {
    const pts = f.map((i) => verts[i]);
    const A = ringArea(pts);
    if (A <= 0 || A / 1e6 < minArea) continue; // negative = outer face of a component
    res.push({ pts: pts.map((p) => [Math.round(p[0]), Math.round(p[1])]), area_m2: A / 1e6 });
  }
  res.sort((x, y) => y.area_m2 - x.area_m2);
  return res.map((f, id) => {
    const c = ringCentroid(f.pts);
    return { id, area_m2: +f.area_m2.toFixed(3), pts: f.pts, cx: Math.round(c[0]), cy: Math.round(c[1]) };
  });
}

/** Segments -> faces. */
export function planarFaces(segs, opts = {}) {
  return traceFaces(buildGraph(segs, opts), opts);
}

const toPcPoly = (ring) => [[...ring, ring[0]]];
function mpArea(mp) {
  let s = 0;
  for (const poly of mp) poly.forEach((ring, i) => { s += (i === 0 ? 1 : -1) * Math.abs(ringArea(ring.slice(0, -1))); });
  return s;
}

/**
 * Add holes: a face wholly inside a larger face (island loops: columns, shafts, courtyards that are not
 * connected to the outer linework) becomes a hole of its smallest container. Returns faces with
 * `holes: [ring...]` and the polygon-difference geometry in `parts` when holes exist (polygon-clipping).
 * `area_m2` becomes net area; `gross_m2` keeps the outer-ring area.
 */
export async function addHoles(faces, { tol = 0.999 } = {}) {
  const pc = await requirePolygonClipping();
  const bbox = (f) => { const xs = f.pts.map((p) => p[0]), ys = f.pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const bb = faces.map(bbox);
  const parent = faces.map(() => -1);
  for (let g = 0; g < faces.length; g++) {
    let best = -1;
    for (let f = 0; f < faces.length; f++) {
      if (f === g || faces[f].area_m2 <= faces[g].area_m2) continue;
      if (bb[g][0] < bb[f][0] || bb[g][1] < bb[f][1] || bb[g][2] > bb[f][2] || bb[g][3] > bb[f][3]) continue;
      const inter = pc.intersection(toPcPoly(faces[f].pts), toPcPoly(faces[g].pts));
      if (mpArea(inter) / 1e6 >= tol * faces[g].area_m2 && (best < 0 || faces[f].area_m2 < faces[best].area_m2)) best = f;
    }
    parent[g] = best;
  }
  return faces.map((f, i) => {
    const kids = faces.filter((_, g) => parent[g] === i);
    if (!kids.length) return { ...f, gross_m2: f.area_m2, holes: [] };
    const diff = pc.difference(toPcPoly(f.pts), ...kids.map((k) => toPcPoly(k.pts)));
    const net = mpArea(diff) / 1e6;
    return {
      ...f,
      gross_m2: f.area_m2,
      area_m2: +net.toFixed(3),
      holes: kids.map((k) => k.pts),
      parts: diff.map((poly) => poly.map((ring) => ring.slice(0, -1).map((p) => [Math.round(p[0]), Math.round(p[1])]))),
    };
  });
}

/**
 * Pinch cleanup: a ring that touches itself at a vertex (figure-8, or a spur one wall thick) is not a valid
 * Revit boundary. Union with itself splits it into valid simple polygons. Returns [{outer, holes}].
 */
export async function cleanPinch(ring) {
  const pc = await requirePolygonClipping();
  const mp = pc.union(toPcPoly(ring));
  return mp.map((poly) => ({
    outer: poly[0].slice(0, -1),
    holes: poly.slice(1).map((r) => r.slice(0, -1)),
  }));
}

// ---------------- CLI ----------------
function cli(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) args[k] = true; else { args[k] = nxt; i++; }
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const a = cli(process.argv.slice(2));
  if (!a._[0] || a.help) {
    console.error('usage: planar_faces.mjs <cad.json> [--layers "A,B"] [--snap 20] [--min-area 3] [--max-chord 600] [--holes] [--pinch] [--out faces.json]');
    process.exit(a.help ? 0 : 2);
  }
  const raw = JSON.parse(fs.readFileSync(a._[0], 'utf8'));
  // accept a bare item array or the get_cad_geometry outFile shape {items:[...]} (also nested under result)
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.result?.items ?? []);
  const layers = typeof a.layers === 'string' ? a.layers.split(',').map((s) => s.trim()) : null;
  const segs = itemsToSegments(items, { layers, maxChord: Number(a['max-chord'] ?? 600) });
  let faces = planarFaces(segs, { snap: Number(a.snap ?? 20), minArea: Number(a['min-area'] ?? 3) });
  if (a.holes) faces = await addHoles(faces);
  if (a.pinch) {
    for (const f of faces) {
      const parts = await cleanPinch(f.pts);
      if (parts.length > 1 || parts[0].outer.length !== f.pts.length) f.pinch_parts = parts;
    }
  }
  const summary = { segments: segs.length, faces: faces.length, total_m2: +faces.reduce((s, f) => s + f.area_m2, 0).toFixed(1) };
  if (a.out) { fs.writeFileSync(a.out, JSON.stringify(faces)); console.log(JSON.stringify({ ...summary, out: a.out })); }
  else console.log(JSON.stringify({ ...summary, faces }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
