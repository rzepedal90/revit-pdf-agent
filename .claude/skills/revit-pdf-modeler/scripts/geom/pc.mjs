// Lazy loader for the optional `polygon-clipping` dependency.
// Resolution order: normal module resolution, then the pdf/ sub-package install
// (npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf).
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

let cached;

export async function loadPolygonClipping() {
  if (cached !== undefined) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    'polygon-clipping',
    pathToFileURL(path.join(here, '..', 'pdf', 'node_modules', 'polygon-clipping', 'dist', 'polygon-clipping.esm.js')).href,
    pathToFileURL(path.join(here, 'node_modules', 'polygon-clipping', 'dist', 'polygon-clipping.esm.js')).href,
  ];
  for (const c of candidates) {
    try {
      const m = await import(c);
      cached = m.default ?? m;
      return cached;
    } catch { /* try next */ }
  }
  cached = null;
  return null;
}

export async function requirePolygonClipping() {
  const pc = await loadPolygonClipping();
  if (!pc) throw new Error('polygon-clipping is not installed. Run: npm install --prefix .claude/skills/revit-pdf-modeler/scripts/pdf');
  return pc;
}
