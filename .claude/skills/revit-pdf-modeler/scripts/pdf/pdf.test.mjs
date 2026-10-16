import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitAffine, calibrate, labelGuess, candidatePoints, applyTransform } from './pdf_calibrate.mjs';
import { filterByStyle, toModel, inRegion, bandMidlines, extractLines, styleHistogram } from './pdf_lines.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hasPdfjs = fs.existsSync(path.join(here, 'node_modules', 'pdfjs-dist'));

// ---------- synthetic drawing ----------
// model->page: u = 300 + 0.0055*y ; v = 800 - 0.0055*x   (V grid names vary along page v, H along page u)
const toPage = (x, y) => [300 + 0.0055 * y, 800 - 0.0055 * x];
const V = { A: 0, B: 8000, C: 16000, D: 24000, E: 32000 };
const H = { 1: 0, 2: 6000, 3: 12000, 4: 18000, 5: 24000 };
const noSymbol = new Set(['B/2', 'D/4', 'C/3']);

function synthetic({ jitter = 0.04 } = {}) {
  const texts = [], segs = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const [n, x] of Object.entries(V)) { const [, v] = toPage(x, 0); texts.push({ s: n, x: 100, y: v, h: 8 }, { s: n, x: 1500, y: v, h: 8 }); }
  for (const [n, y] of Object.entries(H)) { const [u] = toPage(0, y); texts.push({ s: n, x: u, y: 50, h: 8 }, { s: n, x: u, y: 780, h: 8 }); }
  texts.push({ s: 'B', x: 700, y: 100, h: 8 }, { s: '3', x: 40, y: 20, h: 8 }); // stray look-alike labels
  for (const [vn, x] of Object.entries(V)) for (const [hn, y] of Object.entries(H)) {
    if (noSymbol.has(vn + '/' + hn)) continue;
    const [u, v] = toPage(x, y), j = () => rnd() * 2 * jitter, h = 2.25;
    const q = [[u - h, v - h], [u + h, v - h], [u + h, v + h], [u - h, v + h]].map(([a, b]) => [a + j(), b + j()]);
    for (let i = 0; i < 4; i++) segs.push({ a: q[i], b: q[(i + 1) % 4], t: 'r', st: [0, 0, 0], fi: null, lw: 0.5 });
  }
  // unrelated geometry that must be ignored: long lines and a big rectangle
  segs.push({ a: [0, 0], b: [1000, 0], t: 'l', st: [0, 0, 0], fi: null, lw: 1 });
  return { texts, segs };
}

test('fitAffine recovers a known affine exactly', () => {
  const pairs = [[0, 0], [10, 0], [0, 10], [7, 5]].map(([u, v]) => ({ u, v, x: 2 * u + 0.5 * v + 100, y: -0.5 * u + 3 * v - 50 }));
  const f = fitAffine(pairs);
  assert.ok(f.rms < 1e-9);
  assert.ok(Math.abs(f.X[0] - 2) < 1e-9 && Math.abs(f.Y[1] - 3) < 1e-9);
  const [u, v] = f.inv(120.5, -20);
  const [x, y] = f.f(u, v);
  assert.ok(Math.abs(x - 120.5) < 1e-9 && Math.abs(y + 20) < 1e-9);
});

test('labelGuess picks the right axes on a rotated layout despite stray labels', () => {
  const { texts } = synthetic();
  const { guess, info } = labelGuess(texts, { V, H });
  assert.equal(info.vAxis, 'v');
  assert.equal(info.hAxis, 'u');
  const [u, v] = guess(16000, 12000), [eu, ev] = toPage(16000, 12000);
  assert.ok(Math.hypot(u - eu, v - ev) < 1, `guess off by ${Math.hypot(u - eu, v - ev)}`);
});

test('calibrate recovers the synthetic transform, matches grid names and finds missing symbols', () => {
  const { texts, segs } = synthetic();
  const res = calibrate({ texts, segs }, { V, H }, { symMin: 3, symMax: 6.5 });
  assert.ok(res.rms < 10, `rms ${res.rms}`);
  assert.equal(res.n, 25 - noSymbol.size);
  assert.deepEqual([...res.missing].sort(), [...noSymbol].sort());
  // transform maps a symbol back to its model coordinates
  const m = res.matched.find((p) => p.grid === 'C/4');
  const [x, y] = applyTransform(res, m.u, m.v);
  assert.ok(Math.hypot(x - 16000, y - 18000) < 30);
  assert.ok(res.columns.some((c) => c.grid === 'A/1' && c.x === 0 && c.y === 0));
});

test('calibrate respects extents (vExt/hExt) and explicit points', () => {
  const { texts, segs } = synthetic();
  const grids = { V, H, vExt: { A: [0, 12000] }, hExt: {} };
  const cands = candidatePoints(grids).map((c) => c.name);
  assert.ok(cands.includes('A/3') && !cands.includes('A/4'));
  const pts = [{ name: 'A/1', x: 0, y: 0 }, { name: 'E/1', x: 32000, y: 0 }, { name: 'A/5', x: 0, y: 24000 }, { name: 'E/5', x: 32000, y: 24000 }, { name: 'C/1', x: 16000, y: 0 }, { name: 'C/5', x: 16000, y: 24000 }];
  const res = calibrate({ texts, segs }, { V, H }, { symMin: 3, symMax: 6.5, points: pts });
  assert.equal(res.n, 6);
  assert.ok(res.rms < 10);
});

test('calibrate fails clearly when labels are missing', () => {
  assert.throws(() => calibrate({ texts: [], segs: [] }, { V, H }), /grid labels/);
});

// ---------- pdf_lines ----------
const seg = (a, b, o = {}) => ({ a, b, t: 'l', st: [0, 0, 0], fi: null, lw: 1.08, ...o });

test('filterByStyle / toModel / inRegion', () => {
  const segs = [seg([0, 0], [10, 0]), seg([0, 0], [10, 0], { lw: 0.3 }), seg([0, 0], [10, 0], { st: null, fi: [149, 149, 149] }), seg([0, 0], [10, 0], { t: 'c' })];
  assert.equal(filterByStyle(segs, { stroke: [0, 0, 0], lw: 1.08 }).length, 1);
  assert.equal(filterByStyle(segs, { fill: [149, 149, 149] }).length, 1);
  assert.equal(filterByStyle(segs, { types: ['c'] }).length, 1);
  const t = { X: [100, 0, 5], Y: [0, 100, 7] };
  assert.deepEqual(toModel([seg([1, 2], [3, 4])], t), [[[105, 207], [305, 407]]]);
  assert.equal(inRegion([[[0, 0], [10, 10]], [[0, 0], [1000, 10]]], [-1, -1, 50, 50]).length, 1);
  assert.ok(Object.keys(styleHistogram(segs)).length >= 3);
});

test('bandMidlines pairs parallel band edges into centerlines (incl. a diagonal)', () => {
  // horizontal wall 6000 long, 200 thick at y=0..200 ; vertical wall 150 thick ; stray single edge
  const edges = [
    [[0, 0], [6000, 0]], [[0, 200], [6000, 200]],
    [[6000, 0], [6000, 5000]], [[6150, 0], [6150, 5000]],
    [[0, 9000], [3000, 9000]],
  ];
  const { mids, thickness_median } = bandMidlines(edges, { minT: 80, maxT: 600 });
  assert.equal(mids.length, 2);
  const h = mids.find(([a, b]) => Math.abs(a[1] - b[1]) < 1);
  assert.ok(Math.abs(h[0][1] - 100) < 1 && Math.abs(Math.abs(h[1][0] - h[0][0]) - 6000) < 1);
  const vv = mids.find(([a, b]) => Math.abs(a[0] - b[0]) < 1);
  assert.ok(Math.abs(vv[0][0] - 6075) < 1);
  assert.ok(thickness_median >= 150 && thickness_median <= 200);
  // diagonal band 45 deg, 200 mm apart measured perpendicular
  const k = 200 / Math.SQRT2;
  const diag = bandMidlines([[[0, 0], [4000, 4000]], [[-k, k], [4000 - k, 4000 + k]]], { minT: 80, maxT: 600 });
  assert.equal(diag.mids.length, 1);
});

test('extractLines pipeline: style + transform + band midlines + merge parallel', () => {
  const t = { X: [10, 0, 0], Y: [0, 10, 0] }; // 1 pt = 10 mm
  const fill = { st: null, fi: [149, 149, 149] };
  const segs = [
    seg([0, 0], [600, 0], fill), seg([0, 20], [600, 20], fill),    // band, 200 mm thick in model
    seg([0, 100], [300, 100]), seg([0, 103], [300, 103]),          // double line 30 mm apart
  ];
  const band = extractLines({ segs }, { transform: t, fill: [149, 149, 149], bandMidlines: true, thickness: [80, 600] });
  assert.equal(band.segs.length, 1);
  assert.equal(band.segs[0][0][1], 100);
  const merged = extractLines({ segs }, { transform: t, stroke: [0, 0, 0], mergeParallelMm: 100 });
  assert.equal(merged.segs.length, 1);
  assert.ok(Math.abs(merged.segs[0][0][1] - 1015) <= 20);
});

// ---------- pdf_extract (needs pdfjs-dist) ----------
function buildPdf(content) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

test('pdf_extract: lines, rectangles, CTM, colours, curves, text', async (t) => {
  if (!hasPdfjs) return t.skip('pdfjs-dist not installed (npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf)');
  const { extractPage } = await import('./pdf_extract.mjs');
  const content = [
    '1 0 0 RG 2 w 100 100 m 300 100 l S',
    '0 0 1 rg 50 50 20 10 re f',
    'q 2 0 0 2 0 0 cm 0 0 0 RG 1 w 10 300 m 60 300 l S Q',
    '0 1 0 RG 0.5 w 10 400 m 20 420 40 420 50 400 c S',
    'BT /F1 12 Tf 72 700 Td (Hello) Tj ET',
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfx-'));
  const file = path.join(dir, 't.pdf');
  fs.writeFileSync(file, buildPdf(content), 'latin1');
  const d = await extractPage(file, 1);
  assert.deepEqual([d.page.w, d.page.h], [600, 800]);
  const hello = d.texts.find((x) => x.s === 'Hello');
  assert.ok(hello && Math.abs(hello.x - 72) < 0.1 && Math.abs(hello.y - 700) < 0.1);
  const red = d.segs.filter((s) => s.st && s.st[0] === 255 && s.st[1] === 0);
  assert.equal(red.length, 1);
  assert.deepEqual([red[0].a, red[0].b, red[0].lw], [[100, 100], [300, 100], 2]);
  const rect = d.segs.filter((s) => s.t === 'r');
  assert.equal(rect.length, 4);
  assert.ok(rect.every((s) => s.fi && s.fi[2] === 255 && s.st === null));
  const scaled = d.segs.find((s) => s.st && s.st.every((c) => c === 0) && s.t === 'l');
  assert.deepEqual([scaled.a, scaled.b, scaled.lw], [[20, 600], [120, 600], 2]); // CTM scale 2 applies to coords and line width
  const curve = d.segs.filter((s) => s.t === 'c');
  assert.equal(curve.length, 8);
  assert.deepEqual(curve.at(-1).b, [50, 400]);
});
