#!/usr/bin/env node
// Page -> model affine calibration from grid labels (initial guess) refined by small square symbols
// (column marks) at grid intersections. Also reports which intersections carry a symbol.
//
//   node pdf_calibrate.mjs extracted.json --grids grids.json --sym-min 3 --sym-max 6.5 \
//        [--region u0,v0,u1,v1] [--guess-radius 7] [--refine-radius 3] [--final-radius 2.5] \
//        [--points points.json] [--out calib.json]
//
// grids.json: { "V": {"A":0,"B":8000}, "H": {"1":0,"2":6000}, "vExt": {"A":[y0,y1]}, "hExt": {"1":[x0,x1]} }
//   V = vertical grid lines, name -> model x (mm). H = horizontal grid lines, name -> model y (mm).
//   vExt/hExt (optional) = extent of each line along its length; intersections outside are not candidates.
// --points (optional): JSON [{name,x,y}] known model points to look for instead of all grid intersections.
// Output: { X:[a,b,c], Y:[d,e,f], rms, max, n, matched:[{grid,u,v,x,y,res}], missing:[grid...], columns:[{grid,x,y}] }
//   x = a*u + b*v + c ; y = d*u + e*v + f   (u,v = page points, x,y = model mm).
// Target: rms < 50 mm on a drawing at 1:100 (1 pt ~ 35 mm).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[p][i])) p = j;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) throw new Error('degenerate point set (collinear points); need at least 3 non-collinear matches');
    for (let j = 0; j < 3; j++) if (j !== i) { const f = m[j][i] / m[i][i]; for (let k = i; k < 4; k++) m[j][k] -= f * m[i][k]; }
  }
  return m.map((r, i) => r[3] / r[i]);
}

/** Least-squares affine fit. pairs: [{u,v,x,y}]. Returns { X, Y, f(u,v), inv(x,y), rms, max, residuals }. */
export function fitAffine(pairs) {
  if (pairs.length < 3) throw new Error('need at least 3 point pairs');
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (const p of pairs) {
    const r = [p.u, p.v, 1];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) N[i][j] += r[i] * r[j]; bx[i] += r[i] * p.x; by[i] += r[i] * p.y; }
  }
  const X = solve3(N, bx), Y = solve3(N, by);
  return affineObject(X, Y, pairs);
}

export function affineObject(X, Y, pairs = []) {
  const f = (u, v) => [X[0] * u + X[1] * v + X[2], Y[0] * u + Y[1] * v + Y[2]];
  const det = X[0] * Y[1] - X[1] * Y[0];
  const inv = (x, y) => [(Y[1] * (x - X[2]) - X[1] * (y - Y[2])) / det, (-Y[0] * (x - X[2]) + X[0] * (y - Y[2])) / det];
  const residuals = pairs.map((p) => { const q = f(p.u, p.v); return Math.hypot(q[0] - p.x, q[1] - p.y); });
  const rms = residuals.length ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) : 0;
  return { X, Y, f, inv, rms, max: residuals.length ? Math.max(...residuals) : 0, residuals };
}

/** Index small axis-aligned segments (side midpoints of square symbols) by length range. */
export function squareIndex(segs, { min = 3.5, max = 5.6, region = null } = {}) {
  const mids = [];
  for (const s of segs) {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L = Math.hypot(dx, dy);
    if (L < min || L > max) continue;
    if (Math.abs(dx) > 0.3 && Math.abs(dy) > 0.3) continue; // axis-aligned only
    const m = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, L];
    if (region && (m[0] < region[0] || m[0] > region[2] || m[1] < region[1] || m[1] > region[3])) continue;
    mids.push(m);
  }
  const cell = Math.max(6, max * 1.2), grid = new Map();
  mids.forEach((m, i) => {
    const k = Math.floor(m[0] / cell) + ',' + Math.floor(m[1] / cell);
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  return { mids, grid, cell };
}

/** Centre of the square symbol nearest (u,v): mean of side midpoints within r. Needs >= 4 midpoints. Returns [u,v,count] or null. */
export function nearestSquareCenter(sq, u, v, r = 4) {
  const pts = [];
  const cu = Math.floor(u / sq.cell), cv = Math.floor(v / sq.cell), n = Math.ceil(r / sq.cell);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const idx of sq.grid.get((cu + i) + ',' + (cv + j)) || []) {
    const m = sq.mids[idx];
    if (Math.hypot(m[0] - u, m[1] - v) <= r) pts.push(m);
  }
  if (pts.length < 4) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.length];
}

function linfit(pts) { // y = m*x + b over [[x,y]]
  const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const m = (n * sxy - sx * sy) / den;
  return { m, b: (sy - m * sx) / n };
}

function robustLine(pts) { // fit, reject > 3*MAD outliers, refit
  let fit = linfit(pts);
  for (let it = 0; it < 3 && fit && pts.length > 3; it++) {
    const res = pts.map((p) => Math.abs(fit.m * p[0] + fit.b - p[1]));
    const sorted = [...res].sort((a, b) => a - b), mad = sorted[Math.floor(sorted.length / 2)];
    const lim = Math.max(3 * mad * 1.4826, 3); // page points; floor avoids rejecting good labels when MAD ~ 0
    const keep = pts.filter((_, i) => res[i] <= lim);
    if (keep.length === pts.length || keep.length < 2) break;
    pts = keep; fit = linfit(pts);
  }
  return fit && { ...fit, n: pts.length };
}

/**
 * Initial affine guess from text labels. For each name in grids.V (x positions) the label's page position is
 * regressed against page u and against page v; the axis with the better correlation wins (handles rotated
 * sheets). H (y positions) uses the other axis. Returns { guess(x,y)->[u,v], info } (axis-aligned guess only).
 */
export function labelGuess(texts, grids, { region = null } = {}) {
  const inRegion = (t) => !region || (t.x >= region[0] && t.x <= region[2] && t.y >= region[1] && t.y <= region[3]);
  const T = texts.filter(inRegion);
  const collect = (map) => { const out = []; for (const t of T) if (Object.hasOwn(map, t.s)) out.push({ name: t.s, val: map[t.s], u: t.x, v: t.y }); return out; };
  const Lv = collect(grids.V || {}), Lh = collect(grids.H || {});
  if (Lv.length < 2 || Lh.length < 2) throw new Error(`not enough grid labels found in the text (V:${Lv.length}, H:${Lh.length}); check names, region and the grids file`);
  // model coordinate as a function of page axis: page = m*model + b (model->page), per axis, per family
  const fam = (L) => ['u', 'v'].map((ax) => ({ ax, fit: robustLine(L.map((l) => [l.val, l[ax]])) }));
  const fv = fam(Lv), fh = fam(Lh);
  const score = (f) => (f.fit ? Math.abs(f.fit.m) : 0);
  // V lines vary along one page axis; choose the combination (V->u,H->v) or (V->v,H->u) with larger total slope
  const a = score(fv[0]) + score(fh[1]), b = score(fv[1]) + score(fh[0]);
  const vAxis = a >= b ? 'u' : 'v', hAxis = a >= b ? 'v' : 'u';
  const fV = fv.find((f) => f.ax === vAxis).fit, fH = fh.find((f) => f.ax === hAxis).fit;
  if (!fV || !fH) throw new Error('could not fit label positions (labels collinear or identical)');
  const guess = (x, y) => {
    const out = { u: 0, v: 0 };
    out[vAxis] = fV.m * x + fV.b;
    out[hAxis] = fH.m * y + fH.b;
    return [out.u, out.v];
  };
  return { guess, info: { vAxis, hAxis, vLabels: fV.n, hLabels: fH.n, vSlope: fV.m, hSlope: fH.m } };
}

/** All candidate intersections (name, x, y) within vExt/hExt. */
export function candidatePoints(grids) {
  const out = [];
  for (const [vn, vx] of Object.entries(grids.V || {})) for (const [hn, hy] of Object.entries(grids.H || {})) {
    const ve = grids.vExt?.[vn], he = grids.hExt?.[hn];
    if (ve && (hy < ve[0] - 1 || hy > ve[1] + 1)) continue;
    if (he && (vx < he[0] - 1 || vx > he[1] + 1)) continue;
    out.push({ name: vn + '/' + hn, x: vx, y: hy });
  }
  return out;
}

/**
 * Calibrate. extracted = pdf_extract output ({texts, segs}); grids as above.
 * opts: { region, symMin, symMax, guessRadius, refineRadius, finalRadius, points, minMatches, maxResidualMm }
 */
export function calibrate(extracted, grids, opts = {}) {
  const { region = null, symMin = 3.5, symMax = 5.6, guessRadius = 7, refineRadius = 3, finalRadius = 2.5, minMatches = 6, maxResidualMm = 150 } = opts;
  const cands = opts.points ?? candidatePoints(grids);
  const { guess, info } = labelGuess(extracted.texts, grids, { region });
  const sq = squareIndex(extracted.segs, { min: symMin, max: symMax, region });
  const matchWith = (project, radius) => {
    const pairs = [];
    for (const c of cands) {
      const [u, v] = project(c.x, c.y);
      const s = nearestSquareCenter(sq, u, v, radius);
      if (s) pairs.push({ u: s[0], v: s[1], x: c.x, y: c.y, g: c.name });
    }
    return pairs;
  };
  let pairs = matchWith(guess, guessRadius);
  if (pairs.length < minMatches) throw new Error(`only ${pairs.length} symbols matched near the label-based guess (need ${minMatches}); adjust --sym-min/--sym-max, --guess-radius or --region`);
  let fit = fitAffine(pairs);
  // refine around the fitted transform, then reject outliers, then a final pass with the tightest radius
  pairs = matchWith(fit.inv, refineRadius);
  fit = fitAffine(pairs);
  const keep = pairs.filter((p) => { const q = fit.f(p.u, p.v); return Math.hypot(q[0] - p.x, q[1] - p.y) < Math.max(maxResidualMm, 3 * fit.rms); });
  fit = fitAffine(keep);
  const final = matchWith(fit.inv, finalRadius);
  fit = fitAffine(final);
  const matched = final.map((p, i) => ({ grid: p.g, u: +p.u.toFixed(2), v: +p.v.toFixed(2), x: p.x, y: p.y, res: +fit.residuals[i].toFixed(1) }));
  const got = new Set(final.map((p) => p.g));
  return {
    X: fit.X, Y: fit.Y, rms: +fit.rms.toFixed(1), max: +fit.max.toFixed(1), n: final.length, candidates: cands.length,
    label_guess: info,
    matched,
    missing: cands.filter((c) => !got.has(c.name)).map((c) => c.name),
    columns: final.map((p) => ({ grid: p.g, x: p.x, y: p.y })),
    f: fit.f,
  };
}

/** Apply a saved calibration { X, Y } to a page point. */
export function applyTransform(t, u, v) { return [t.X[0] * u + t.X[1] * v + t.X[2], t.Y[0] * u + t.Y[1] * v + t.Y[2]]; }

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
  if (!a._[0] || !a.grids || a.help) {
    console.error('usage: pdf_calibrate.mjs <extracted.json> --grids grids.json [--sym-min 3.5] [--sym-max 5.6] [--region u0,v0,u1,v1] [--guess-radius 7] [--refine-radius 3] [--final-radius 2.5] [--points points.json] [--out calib.json]');
    process.exit(a.help ? 0 : 2);
  }
  const extracted = JSON.parse(fs.readFileSync(a._[0], 'utf8'));
  const grids = JSON.parse(fs.readFileSync(a.grids, 'utf8'));
  const num = (k, d) => (a[k] !== undefined ? Number(a[k]) : d);
  const res = calibrate(extracted, grids, {
    region: typeof a.region === 'string' ? a.region.split(',').map(Number) : null,
    symMin: num('sym-min', 3.5), symMax: num('sym-max', 5.6),
    guessRadius: num('guess-radius', 7), refineRadius: num('refine-radius', 3), finalRadius: num('final-radius', 2.5),
    points: a.points ? JSON.parse(fs.readFileSync(a.points, 'utf8')) : undefined,
  });
  const { f, ...out } = res;
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(out));
  console.log(JSON.stringify({ rms_mm: out.rms, max_mm: out.max, matched: out.n, candidates: out.candidates, missing: out.missing, ok_rms_lt_50: out.rms < 50, ...(a.out ? { out: a.out } : { X: out.X, Y: out.Y }) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
