#!/usr/bin/env node
// Filter extracted PDF segments by style and region, transform to model mm, optionally derive wall
// centerlines from band edges or merge parallel doubles.
//
//   node pdf_lines.mjs extracted.json --calib calib.json --stroke 0,0,0 --lw 1.08 --region x0,y0,x1,y1 --out walls.json
//   node pdf_lines.mjs extracted.json --calib calib.json --fill 149,149,149 --band-midlines --thickness 80,600 --out mids.json
//   node pdf_lines.mjs extracted.json --calib calib.json --list-styles          (style histogram, metres per style)
//
// Filters: --stroke r,g,b | --fill r,g,b | --lw w [--lw-tol 0.02] | --lw-min/--lw-max | --types l,r,c (default l,r)
//          --region x0,y0,x1,y1 (model mm; both endpoints must be inside)
// Modes:   --band-midlines [--thickness min,max]  pair parallel band edges (wall drawn as two edges / filled strip) into centerlines
//          --merge-parallel <mm>                  merge overlapping parallel lines closer than mm (double lines)
//          --dedupe                               merge collinear/duplicate pieces (default on with the two modes above)
//          --min-len <mm> (default 200)
// Output: JSON array of [[x,y],[x,y]] integer mm. calib.json = pdf_calibrate output ({X,Y}); omit --calib to stay in page points.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dedupeLines, mergeParallel } from '../geom/wall_clean.mjs';

const len = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const colorEq = (c, want, tol = 1) => c && want && c.every((v, i) => Math.abs(v - want[i]) <= tol);

/** Style histogram: { 'lw=1.08 st=[0,0,0] fi=null': metres }. */
export function styleHistogram(segs, { types = ['l', 'r'] } = {}) {
  const h = {};
  for (const s of segs) {
    if (!types.includes(s.t)) continue;
    const k = `lw=${s.lw} st=${JSON.stringify(s.st)} fi=${JSON.stringify(s.fi)}`;
    h[k] = (h[k] || 0) + len([s.a, s.b]);
  }
  return h;
}

/** Filter segments (page space) by style. */
export function filterByStyle(segs, { stroke, fill, lw, lwTol = 0.02, lwMin, lwMax, types = ['l', 'r'], colorTol = 1 } = {}) {
  return segs.filter((s) => {
    if (!types.includes(s.t)) return false;
    if (stroke && !colorEq(s.st, stroke, colorTol)) return false;
    if (fill && !colorEq(s.fi, fill, colorTol)) return false;
    if (lw !== undefined && Math.abs(s.lw - lw) > lwTol) return false;
    if (lwMin !== undefined && s.lw < lwMin) return false;
    if (lwMax !== undefined && s.lw > lwMax) return false;
    return true;
  });
}

/** Page segments -> model [[A,B]] using {X,Y} (or identity when transform is null). */
export function toModel(segs, t) {
  const f = t ? (p) => [t.X[0] * p[0] + t.X[1] * p[1] + t.X[2], t.Y[0] * p[0] + t.Y[1] * p[1] + t.Y[2]] : (p) => p;
  return segs.map((s) => [f(s.a), f(s.b)]);
}

export function inRegion(segs, r) {
  if (!r) return segs;
  const ok = (p) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  return segs.filter(([a, b]) => ok(a) && ok(b));
}

const normAngle = (a, b) => { let th = Math.atan2(b[1] - a[1], b[0] - a[0]); if (th < 0) th += Math.PI; if (th >= Math.PI - 1e-9) th -= Math.PI; return th; };

/**
 * Pair parallel band edges whose perpendicular distance is in [minT, maxT] and that overlap by >= minOverlap
 * along their length; emit the midline of the overlap. A wall drawn as a filled strip yields two long edges
 * (plus short end caps, ignored via minSeg). Result is de-duplicated (loose tolerances).
 * Returns { mids, thickness_median }.
 */
export function bandMidlines(segs, { minT = 80, maxT = 600, minSeg = 250, minOverlap = 250, angTol = 0.01, dedupe = true } = {}) {
  const S = segs.filter((s) => len(s) > minSeg).map(([a, b]) => {
    const th = normAngle(a, b), n = [-Math.sin(th), Math.cos(th)], d = [Math.cos(th), Math.sin(th)];
    const ta = a[0] * d[0] + a[1] * d[1], tb = b[0] * d[0] + b[1] * d[1];
    return { a, b, th, n, d, t0: Math.min(ta, tb), t1: Math.max(ta, tb) };
  }).sort((p, q) => p.th - q.th);
  const mids = [], thick = [];
  const pair = (p, q) => {
    // distance measured on p's normal so wrap-around pairs (th ~ 0 vs th ~ pi) work
    const op = p.a[0] * p.n[0] + p.a[1] * p.n[1], oq = q.a[0] * p.n[0] + q.a[1] * p.n[1];
    const dist = Math.abs(op - oq);
    if (dist < minT || dist > maxT) return;
    const qt = [q.a, q.b].map((pt) => pt[0] * p.d[0] + pt[1] * p.d[1]);
    const t0 = Math.max(p.t0, Math.min(...qt)), t1 = Math.min(p.t1, Math.max(...qt));
    if (t1 - t0 < minOverlap) return;
    const off = (op + oq) / 2;
    mids.push([[p.d[0] * t0 + p.n[0] * off, p.d[1] * t0 + p.n[1] * off], [p.d[0] * t1 + p.n[0] * off, p.d[1] * t1 + p.n[1] * off]]);
    thick.push(dist);
  };
  for (let i = 0; i < S.length; i++) {
    for (let j = i + 1; j < S.length && S[j].th - S[i].th < angTol; j++) pair(S[i], S[j]);
    if (S[i].th < angTol) for (let j = S.length - 1; j > i && Math.PI - S[j].th < angTol; j--) pair(S[i], S[j]);
  }
  thick.sort((x, y) => x - y);
  return { mids: dedupe ? dedupeLines(mids, { angTol: 0.01, offTol: 60, gap: 400, minLen: minOverlap }) : mids, thickness_median: thick.length ? thick[Math.floor(thick.length / 2)] : null };
}

const csv = (s) => (typeof s === 'string' ? s.split(',').map(Number) : undefined);

/** Programmatic pipeline mirroring the CLI. */
export function extractLines(extracted, opts = {}) {
  const { transform = null, region, bandMidlines: band, thickness = [80, 600], mergeParallelMm = 0, dedupe, minLen = 200 } = opts;
  const styled = filterByStyle(extracted.segs, opts);
  let segs = inRegion(toModel(styled, transform), region);
  let report = { styled: styled.length, in_region: segs.length };
  if (band) {
    const r = bandMidlines(segs, { minT: thickness[0], maxT: thickness[1] });
    segs = r.mids; report.thickness_median_mm = r.thickness_median;
  } else if (dedupe || mergeParallelMm > 0) segs = dedupeLines(segs, { minLen: 0 });
  if (mergeParallelMm > 0) segs = dedupeLines(mergeParallel(segs, mergeParallelMm), { minLen: 0, offTol: 5, gap: 5 });
  segs = segs.map(([a, b]) => [a.map(Math.round), b.map(Math.round)]).filter((s) => len(s) >= minLen);
  report.lines = segs.length; report.total_m = +(segs.reduce((t, s) => t + len(s), 0) / 1000).toFixed(1);
  return { segs, report };
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
    console.error('usage: pdf_lines.mjs <extracted.json> [--calib calib.json] [--stroke r,g,b] [--fill r,g,b] [--lw w] [--region x0,y0,x1,y1] [--band-midlines --thickness min,max] [--merge-parallel mm] [--list-styles] [--out lines.json]');
    process.exit(a.help ? 0 : 2);
  }
  const extracted = JSON.parse(fs.readFileSync(a._[0], 'utf8'));
  const transform = a.calib ? JSON.parse(fs.readFileSync(a.calib, 'utf8')) : null;
  const types = typeof a.types === 'string' ? a.types.split(',') : ['l', 'r'];
  if (a['list-styles']) {
    let segs = extracted.segs.filter((s) => types.includes(s.t));
    const region = csv(a.region);
    if (region) { const m = toModel(segs, transform); segs = segs.filter((_, k) => inRegion([m[k]], region).length); }
    // Measure in model mm when calibrated (lengths were previously summed in page points but labelled metres).
    if (transform) { const m = toModel(segs, transform); segs = segs.map((s, k) => ({ ...s, a: m[k][0], b: m[k][1] })); }
    const h = Object.entries(styleHistogram(segs, { types })).sort((x, y) => y[1] - x[1]).slice(0, 30);
    const unit = transform ? 1000 : 1;
    for (const [k, v] of h) console.log(((v / unit)).toFixed(1).padStart(10) + (transform ? ' m  ' : ' pt ') + k);
    return;
  }
  const { segs, report } = extractLines(extracted, {
    transform, types, stroke: csv(a.stroke), fill: csv(a.fill),
    lw: a.lw !== undefined ? Number(a.lw) : undefined, lwTol: a['lw-tol'] !== undefined ? Number(a['lw-tol']) : 0.02,
    lwMin: a['lw-min'] !== undefined ? Number(a['lw-min']) : undefined, lwMax: a['lw-max'] !== undefined ? Number(a['lw-max']) : undefined,
    region: csv(a.region), bandMidlines: !!a['band-midlines'], thickness: csv(a.thickness) ?? [80, 600],
    mergeParallelMm: a['merge-parallel'] ? Number(a['merge-parallel']) : 0, dedupe: !!a.dedupe,
    minLen: a['min-len'] !== undefined ? Number(a['min-len']) : 200,
  });
  if (a.out) { fs.writeFileSync(a.out, JSON.stringify(segs)); console.log(JSON.stringify({ ...report, out: a.out })); }
  else console.log(JSON.stringify({ ...report, segs }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
