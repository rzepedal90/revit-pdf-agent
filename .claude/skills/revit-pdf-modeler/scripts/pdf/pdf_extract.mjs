#!/usr/bin/env node
// Extract text items and stroked/filled vector segments (page coordinates, PDF points) from one PDF page.
//
//   node pdf_extract.mjs plan.pdf --page 1 --out plan_p1.json
//
// Output JSON:
//   { file, pageNumber, page:{w,h},
//     texts:[{s,x,y,h}],                       // string, baseline origin (x,y), glyph height
//     segs:[{a:[u,v], b:[u,v], t:'l'|'r'|'c', st:[r,g,b]|null, fi:[r,g,b]|null, lw}] }
// t: 'l' line, 'r' side of a re-operator rectangle, 'c' flattened curve piece. st = stroke colour when the
// path is stroked, fi = fill colour when filled (0-255 ints); lw = line width in page points (CTM-scaled).
// The page coordinate system is PDF user space (origin bottom-left), same as pdf.js text transforms.
// Requires: npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bezierPoints } from '../geom/arc.mjs';

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r2 = (p) => [+p[0].toFixed(2), +p[1].toFixed(2)];

/** pdf.js colour args -> [r,g,b] ints (accepts '#rrggbb' strings and 0-255 numbers). */
export function parseColor(a) {
  if (typeof a[0] === 'string') {
    const h = a[0].replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [Math.round(a[0]), Math.round(a[1]), Math.round(a[2])];
}
const gray = (g) => { const v = Math.round(g * 255); return [v, v, v]; };

/**
 * Walk a pdf.js operator list and collect segments. Exported so it can be unit-tested with a fake list.
 * `OPS` is pdfjs.OPS. Handles save/restore, cm (CTM), line width, RGB/gray colours, re rectangles,
 * lines, closePath and cubic curves (c, v, y flattened into 8 pieces).
 */
export function segmentsFromOperatorList(ol, OPS, { curveSteps = 8 } = {}) {
  let ctm = [1, 0, 0, 1, 0, 0], stack = [], stroke = [0, 0, 0], fill = [0, 0, 0], lw = 1;
  const segs = [];
  let pending = [];
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const paintOps = new Set([...strokeOps, ...fillOps, OPS.endPath]);
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, stroke, fill, lw]);
    else if (fn === OPS.restore) [ctm, stroke, fill, lw] = stack.pop() ?? [ctm, stroke, fill, lw];
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.setLineWidth) lw = a[0];
    else if (fn === OPS.setStrokeRGBColor) stroke = parseColor(a);
    else if (fn === OPS.setFillRGBColor) fill = parseColor(a);
    else if (fn === OPS.setStrokeGray) stroke = gray(a[0]);
    else if (fn === OPS.setFillGray) fill = gray(a[0]);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = a;
      let k = 0, cur = null, start = null;
      const curve = (c1, c2, p) => {
        const pts = bezierPoints(cur, c1, c2, p, curveSteps);
        for (let j = 0; j + 1 < pts.length; j++) pending.push([pts[j], pts[j + 1], 'c']);
        cur = p;
      };
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = ap(ctm, coords[k], coords[k + 1]); start = cur; k += 2; }
        else if (op === OPS.lineTo) { const p = ap(ctm, coords[k], coords[k + 1]); if (cur) pending.push([cur, p, 'l']); cur = p; k += 2; }
        else if (op === OPS.curveTo) { curve(ap(ctm, coords[k], coords[k + 1]), ap(ctm, coords[k + 2], coords[k + 3]), ap(ctm, coords[k + 4], coords[k + 5])); k += 6; }
        else if (op === OPS.curveTo2) { curve(cur, ap(ctm, coords[k], coords[k + 1]), ap(ctm, coords[k + 2], coords[k + 3])); k += 4; } // v: c1 = current point
        else if (op === OPS.curveTo3) { const e = ap(ctm, coords[k + 2], coords[k + 3]); curve(ap(ctm, coords[k], coords[k + 1]), e, e); k += 4; } // y: c2 = end point
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(k, k + 4);
          const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => ap(ctm, p[0], p[1]));
          for (let j = 0; j < 4; j++) pending.push([q[j], q[(j + 1) % 4], 'r']);
          cur = q[0]; start = q[0];
          k += 4;
        } else if (op === OPS.closePath) { if (cur && start) pending.push([cur, start, 'l']); cur = start; }
      }
    } else if (paintOps.has(fn)) {
      if (fn !== OPS.endPath) {
        const lwPage = +(lw * Math.hypot(ctm[0], ctm[1])).toFixed(3);
        for (const s of pending) {
          if (!s[0] || !s[1]) continue;
          segs.push({ a: r2(s[0]), b: r2(s[1]), t: s[2], st: strokeOps.has(fn) ? stroke : null, fi: fillOps.has(fn) ? fill : null, lw: lwPage });
        }
      }
      pending = [];
    }
  }
  return segs;
}

export async function extractPage(file, pageNumber = 1) {
  let pdfjs;
  try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
  catch { throw new Error('pdfjs-dist is not installed. Run: npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf'); }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const texts = tc.items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({ s: i.str.trim(), x: +i.transform[4].toFixed(2), y: +i.transform[5].toFixed(2), h: +Math.hypot(i.transform[2], i.transform[3]).toFixed(2) }));
  const ol = await page.getOperatorList();
  const segs = segmentsFromOperatorList(ol, pdfjs.OPS);
  return { file, pageNumber, page: { w: vp.width, h: vp.height, numPages: doc.numPages }, texts, segs };
}

function cli(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; } }
    else a._.push(argv[i]);
  }
  return a;
}

async function main() {
  const a = cli(process.argv.slice(2));
  if (!a._[0] || a.help) {
    console.error('usage: pdf_extract.mjs <file.pdf> [--page N] [--out extracted.json]');
    process.exit(a.help ? 0 : 2);
  }
  const d = await extractPage(a._[0], Number(a.page ?? 1));
  const summary = { texts: d.texts.length, segs: d.segs.length, page: [d.page.w, d.page.h], numPages: d.page.numPages };
  if (a.out) { fs.writeFileSync(a.out, JSON.stringify(d)); console.log(JSON.stringify({ ...summary, out: a.out })); }
  else console.log(JSON.stringify({ ...summary, note: 'pass --out to save the full extraction' }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
