#!/usr/bin/env node
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
/**
 * Numerical model QA. Acceptance = these numbers (mm / degrees), never the PDF overlay.
 *
 * node qa_model.mjs --manifest m.json --readback r.json [--sources s.json] [--out report.json]
 *   r.json  : get_elements_info output, an array of such outputs, or an array of items
 *   s.json  : find_by_source_key output (or an array of them)
 * Exit: 0 all pass (warnings allowed), 1 any failure, 2 usage / unreadable input.
 *
 * Assumed manifest conventions are documented in references/qa.md.
 */
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarize} from './json_summary.mjs';

const DEF = {xy: 2, z: 2, size: 2, rotation_deg: 0.5, support_xy: 50, support_z: 2, overlap_mm2: 1e4};
const num = v => typeof v === 'number' && Number.isFinite(v);
const r3 = v => (num(v) ? Math.round(v * 1000) / 1000 : v);
const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const fmtPt = p => (p ? p.map(r3).join(',') : p);
const pick = (o, keys) => { for (const k of keys) if (num(o?.[k])) return o[k]; return undefined; };

export function kindOf(category) {
  const c = norm(category);
  if (c.includes('foundation') || c.includes('cimentaci')) return 'footing';
  if (c.includes('column') || c.includes('pilar')) return 'column';
  if (c.includes('framing') || c.includes('beam') || c.includes('viga')) return 'beam';
  if (c.includes('wall') || c.includes('muro')) return 'wall';
  return 'other';
}

/** Normalise the accepted readback shapes into Map<id,item>. */
export function normalizeReadback(readback) {
  const items = [];
  const visit = v => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && Array.isArray(v.items)) v.items.forEach(visit);
    else if (v && typeof v === 'object' && v.id !== undefined) items.push(v);
  };
  visit(readback);
  const map = new Map();
  for (const it of items) map.set(String(it.id), it);
  return map;
}

/** Merge find_by_source_key outputs: key -> matches plus explicit duplicate keys. */
export function normalizeSources(sources) {
  const byKey = new Map();
  const dupKeys = new Set();
  const list = Array.isArray(sources) ? sources : sources ? [sources] : [];
  for (const s of list) {
    for (const m of s.matches ?? []) {
      const arr = byKey.get(m.sourceKey) ?? [];
      if (!arr.some(x => String(x.id) === String(m.id))) arr.push(m);
      byKey.set(m.sourceKey, arr);
    }
    for (const d of s.duplicates ?? []) dupKeys.add(d.sourceKey);
  }
  return {byKey, dupKeys};
}

function applyTransform(tf, x, y) {
  const o = tf?.originMm ?? {x: 0, y: 0};
  const a = ((tf?.rotationDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [o.x + c * x - s * y, o.y + s * x + c * y];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angDiff = (a, b, mod) => { const d = (((a - b) % mod) + mod) % mod; return d > mod / 2 ? d - mod : d; };

export function runQa(manifest, readback, sourceIndex) {
  const rows = [];
  const notes = [];
  const add = (source_key, check, status, expected, actual, delta, note) => {
    const row = {source_key, check, status, expected, actual, delta};
    if (note) row.note = note;
    rows.push(row);
  };
  const cmpNum = (key, check, expected, actual, tol, note) => {
    if (!num(actual)) return add(key, check, 'fail', r3(expected), null, null, 'readback value missing');
    add(key, check, Math.abs(actual - expected) <= tol + 1e-9 ? 'pass' : 'fail', r3(expected), r3(actual), r3(actual - expected), note);
  };

  const at = manifest.acceptance_tests ?? {};
  const tolsIn = at.tolerances_mm ?? {};
  const tol = {
    xy: tolsIn.xy ?? DEF.xy,
    z: tolsIn.z ?? DEF.z,
    size: tolsIn.size ?? at.dimension_tolerance_mm ?? DEF.size,
    rot: at.rotation_tol_deg ?? tolsIn.rotation_deg ?? DEF.rotation_deg,
    sxy: tolsIn.support_xy ?? DEF.support_xy,
    sz: tolsIn.support_z ?? DEF.support_z,
    overlap: at.overlap_threshold_mm2 ?? DEF.overlap_mm2,
  };
  const aliases = at.category_aliases ?? {};
  const levels = new Map((manifest.levels ?? []).map(l => [l.name, l.elevation_mm]));
  const lvl = name => (levels.has(name) ? levels.get(name) : undefined);
  const tf = manifest.coordinate_basis?.transform_to_model;
  if (!tf) notes.push('coordinate_basis.transform_to_model absent: identity transform assumed');
  const types = new Map((manifest.type_manifest ?? []).map(t => [t.source_key, t]));
  const els = manifest.element_manifest ?? [];
  const elByKey = new Map(els.map(e => [e.source_key, e]));
  const resolved = els.filter(e => e.status === 'resolved');
  const items = readback instanceof Map ? readback : normalizeReadback(readback);
  const idx = sourceIndex && sourceIndex.byKey ? sourceIndex : normalizeSources(sourceIndex);

  // key -> [ids]; sourceIndex and readback sourceKey are merged by id.
  const modelByKey = new Map();
  const push = (key, id) => {
    const arr = modelByKey.get(key) ?? [];
    if (!arr.includes(String(id))) arr.push(String(id));
    modelByKey.set(key, arr);
  };
  for (const [key, ms] of idx.byKey) for (const m of ms) push(key, m.id);
  for (const it of items.values()) if (it.sourceKey) push(it.sourceKey, it.id);
  const itemFor = key => {
    const ids = modelByKey.get(key);
    return ids?.length === 1 ? items.get(ids[0]) : undefined;
  };

  // ---- 1. identity -------------------------------------------------------
  for (const e of resolved) {
    const ids = modelByKey.get(e.source_key) ?? [];
    const n = ids.length;
    const dup = n > 1 || idx.dupKeys.has(e.source_key);
    add(e.source_key, 'identity', n === 1 && !dup ? 'pass' : 'fail', 1, n, n - 1,
      n === 0 ? 'missing in model' : dup ? `duplicate ids ${ids.join(',')}` : undefined);
    if (n === 1 && !items.has(ids[0])) add(e.source_key, 'readback', 'fail', 'item', 'absent', null, 'no get_elements_info item for id ' + ids[0]);
  }
  const blocked = new Set([
    ...els.filter(e => e.status === 'blocked' || e.status === 'excluded').map(e => e.source_key),
    ...(at.blocked_source_keys ?? []), ...(at.excluded_source_keys ?? []),
  ]);
  for (const key of blocked) {
    const n = (modelByKey.get(key) ?? []).length;
    add(key, 'blocked_absent', n === 0 ? 'pass' : 'fail', 0, n, n);
  }
  const allKeys = [...elByKey.keys(), ...types.keys()];
  const prefix = at.key_prefix ?? (allKeys.length ? allKeys[0].split('/')[0] + '/' : null);
  if (prefix) {
    for (const key of modelByKey.keys()) {
      if (key.startsWith(prefix) && !elByKey.has(key) && !types.has(key) && !blocked.has(key))
        add(key, 'extra_key', 'fail', 'absent', 'present', null, 'generated element not in manifest');
    }
  } else notes.push('no key prefix derivable: extra-key check skipped');

  // ---- 2. counts ---------------------------------------------------------
  const actualCounts = {};
  for (const [key, ids] of modelByKey) {
    const row = elByKey.get(key);
    const generated = !row && prefix && key.startsWith(prefix) && !types.has(key);
    if (row?.status !== 'resolved' && !generated) continue;
    const c = row?.category ?? norm(items.get(ids[0])?.category);
    actualCounts[c] = (actualCounts[c] ?? 0) + ids.length;
  }
  const rowCounts = {};
  for (const e of resolved) rowCounts[e.category] = (rowCounts[e.category] ?? 0) + 1;
  const exp = at.expected_counts ?? {};
  for (const c of new Set([...Object.keys(exp), ...Object.keys(rowCounts), ...Object.keys(actualCounts)])) {
    const a = actualCounts[c] ?? 0;
    if (Object.keys(exp).length) add(c, 'counts_expected', (exp[c] ?? 0) === a ? 'pass' : 'fail', exp[c] ?? 0, a, a - (exp[c] ?? 0));
    const rr = rowCounts[c] ?? 0;
    add(c, 'counts_rows', rr === a ? 'pass' : 'fail', rr, a, a - rr);
  }

  // ---- per element -------------------------------------------------------
  const present = [];
  for (const e of resolved) {
    const item = itemFor(e.source_key);
    if (item) present.push({row: e, item, kind: kindOf(e.category), swapped: false});
  }

  for (const p of present) {
    const {row: e, item, kind} = p;
    const key = e.source_key;
    const t = types.get(e.type_key);
    const okCat = norm(item.category) === norm(e.category) || (aliases[e.category] ?? []).some(a => same(a, item.category));
    add(key, 'category', okCat ? 'pass' : 'fail', e.category, item.category ?? null, null,
      okCat ? undefined : 'localized Revit category names need acceptance_tests.category_aliases');
    // 3. type / family / material
    if (!t) add(key, 'type', 'fail', e.type_key ?? null, null, null, 'type_key not found in type_manifest');
    else {
      if (t.family !== undefined) add(key, 'family', same(t.family, item.family) ? 'pass' : 'fail', t.family, item.family ?? null, null);
      if (t.type !== undefined) add(key, 'type', same(t.type, item.type) ? 'pass' : 'fail', t.type, item.type ?? null, null);
      if (t.material) add(key, 'material', same(t.material, item.material) ? 'pass' : 'fail', t.material, item.material ?? null, null);
    }
    // 4. XY + rotation
    const g = e.geometry_mm ?? {};
    const loc = item.location ?? {};
    let totalRot;
    if (g.start && g.end) {
      const s = applyTransform(tf, g.start[0], g.start[1]), en = applyTransform(tf, g.end[0], g.end[1]);
      if (!loc.start || !loc.end) add(key, 'xy', 'fail', `${fmtPt(s)}..${fmtPt(en)}`, null, null, 'readback curve location missing');
      else {
        const a = [loc.start[0], loc.start[1]], b = [loc.end[0], loc.end[1]];
        const fwd = Math.max(dist(s, a), dist(en, b)), rev = Math.max(dist(s, b), dist(en, a));
        p.swapped = rev < fwd;
        const d = Math.min(fwd, rev);
        add(key, 'xy', d <= tol.xy + 1e-9 ? 'pass' : 'fail', `${fmtPt(s)}..${fmtPt(en)}`, `${fmtPt(a)}..${fmtPt(b)}`, r3(d), p.swapped ? 'endpoints reversed (accepted)' : undefined);
      }
    } else if (num(g.x) && num(g.y)) {
      const pt = applyTransform(tf, g.x, g.y);
      if (!loc.point) add(key, 'xy', 'fail', fmtPt(pt), null, null, 'readback point location missing');
      else {
        const d = dist(pt, loc.point);
        add(key, 'xy', d <= tol.xy + 1e-9 ? 'pass' : 'fail', fmtPt(pt), fmtPt([loc.point[0], loc.point[1]]), r3(d));
      }
      if (num(g.rotation_deg)) {
        totalRot = g.rotation_deg + (tf?.rotationDeg ?? 0);
        const mod = e.symmetric === true || t?.symmetric === true ? 180 : 360;
        if (!num(loc.rotationDeg)) add(key, 'rotation', 'fail', r3(totalRot), null, null, 'readback rotation missing');
        else {
          const d = angDiff(loc.rotationDeg, totalRot, mod);
          add(key, 'rotation', Math.abs(d) <= tol.rot + 1e-9 ? 'pass' : 'fail', r3(((totalRot % mod) + mod) % mod), r3(((loc.rotationDeg % mod) + mod) % mod), r3(d), `mod ${mod}`);
        }
      }
    } else add(key, 'xy', 'skip', null, null, null, 'manifest geometry_mm has neither {x,y} nor {start,end}');

    // 5. Z
    const z = e.z_constraints ?? {};
    const bb = item.bbox;
    if (kind === 'footing') {
      const l = lvl(z.level);
      if (l === undefined || !num(z.offset_mm)) add(key, 'z_top', 'skip', null, null, null, 'z_constraints {level, offset_mm} unusable');
      else cmpNum(key, 'z_top', l + z.offset_mm, item.topElevation ?? bb?.max?.[2], tol.z, 'footing top = level + offset');
    } else if (kind === 'column') {
      const bl = lvl(z.base_level ?? z.level), tl = lvl(z.top_level);
      const bo = z.base_offset_mm ?? z.offset_mm, to = z.top_offset_mm;
      if (bl !== undefined && num(bo)) {
        cmpNum(key, 'z_base', bl + bo, bb?.min?.[2], tol.z);
        if (num(item.offsets?.baseOffset)) cmpNum(key, 'z_base_offset', bo, item.offsets.baseOffset, tol.z);
        if (item.offsets?.baseLevel) add(key, 'z_base_level', same(item.offsets.baseLevel, z.base_level ?? z.level) ? 'pass' : 'fail', z.base_level ?? z.level, item.offsets.baseLevel, null);
      } else add(key, 'z_base', 'skip', null, null, null, 'base level/offset missing');
      if (tl !== undefined && num(to)) {
        cmpNum(key, 'z_top', tl + to, bb?.max?.[2], tol.z);
        if (num(item.offsets?.topOffset)) cmpNum(key, 'z_top_offset', to, item.offsets.topOffset, tol.z);
        if (item.offsets?.topLevel) add(key, 'z_top_level', same(item.offsets.topLevel, z.top_level) ? 'pass' : 'fail', z.top_level, item.offsets.topLevel, null);
      }
    } else if (kind === 'beam') {
      const l = lvl(z.level);
      const so = z.start_offset_mm ?? z.offset_mm, eo = z.end_offset_mm ?? z.offset_mm;
      if (l === undefined || !num(so) || !num(eo)) add(key, 'z_top', 'skip', null, null, null, 'beam z_constraints {level,start_offset_mm,end_offset_mm} unusable');
      else {
        const sw = p.swapped;
        const rs = loc.start?.[2], re = loc.end?.[2];
        const aS = sw ? re : rs, aE = sw ? rs : re;
        if (num(aS)) cmpNum(key, 'z_end0', l + so, aS, tol.z, 'reference line at start');
        if (num(aE)) cmpNum(key, 'z_end1', l + eo, aE, tol.z, 'reference line at end');
        const oS = sw ? item.offsets?.endZOffset : item.offsets?.startZOffset;
        const oE = sw ? item.offsets?.startZOffset : item.offsets?.endZOffset;
        if (num(oS)) cmpNum(key, 'z_start_offset', so, oS, tol.z);
        if (num(oE)) cmpNum(key, 'z_end_offset', eo, oE, tol.z);
        const j = norm(z.z_justification ?? 'top');
        const h = pick(t?.dimensions_mm, ['height', 'h', 'depth']);
        if (z.z_justification && item.offsets?.zJustification && !same(item.offsets.zJustification, z.z_justification))
          add(key, 'z_justification', 'fail', z.z_justification, item.offsets.zJustification, null);
        let up;
        if (j === 'top') up = 0;
        else if (j === 'center' && num(h)) up = h / 2;
        else if (j === 'bottom' && num(h)) up = h;
        if (up === undefined) add(key, 'z_top', 'skip', null, null, null, `z_justification '${z.z_justification}' needs top|center|bottom (+ type height)`);
        else cmpNum(key, 'z_top', l + Math.max(so, eo) + up, bb?.max?.[2], tol.z, `beam top, justification ${j}`);
      }
    }

    // 6. size (footings/columns), rotation-aware for multiples of 90
    if ((kind === 'footing' || kind === 'column') && t?.dimensions_mm && bb) {
      const dm = t.dimensions_mm;
      let lx = pick(dm, ['length', 'x', 'b']), ly = pick(dm, ['width', 'y', 'h', 'depth']);
      if (lx === undefined && num(dm.width) && num(dm.depth)) { lx = dm.width; ly = dm.depth; }
      if (num(dm.diameter)) { lx = dm.diameter; ly = dm.diameter; }
      const rot = totalRot ?? (g.rotation_deg === undefined ? 0 : undefined);
      if (lx === undefined || ly === undefined) add(key, 'size', 'skip', null, null, null, 'type dimensions_mm lack length/width');
      else if (rot === undefined || Math.abs(angDiff(rot, Math.round(rot / 90) * 90, 360)) > 0.01) add(key, 'size', 'skip', null, null, null, 'rotation not a multiple of 90: bbox size check skipped');
      else {
        const swap = (((Math.round(rot / 90) % 2) + 2) % 2) === 1;
        cmpNum(key, 'size_x', swap ? ly : lx, bb.max[0] - bb.min[0], tol.size);
        cmpNum(key, 'size_y', swap ? lx : ly, bb.max[1] - bb.min[1], tol.size);
      }
    }
  }

  // datum table rows {name, value_mm, level_ref, category?, source_keys?, status}
  for (const d of manifest.datum_table ?? []) {
    if ((d.status && d.status !== 'resolved') || (!d.category && !d.source_keys)) continue;
    if (!/top/i.test(d.name ?? '') || !num(d.value_mm)) continue;
    const base = d.level_ref === 'absolute' ? 0 : lvl(d.level_ref);
    if (base === undefined) { add(d.name, 'datum', 'skip', null, null, null, `unknown level_ref ${d.level_ref}`); continue; }
    for (const p of present) {
      if (d.source_keys ? !d.source_keys.includes(p.row.source_key) : p.row.category !== d.category) continue;
      cmpNum(p.row.source_key, 'datum:' + d.name, base + d.value_mm, p.item.bbox?.max?.[2] ?? p.item.topElevation, tol.z);
    }
  }

  // ---- 7. support --------------------------------------------------------
  const bboxOk = p => p.item.bbox?.min && p.item.bbox?.max;
  const footings = present.filter(p => p.kind === 'footing' && bboxOk(p));
  const inXY = (pt, b, t) => pt[0] >= b.min[0] - t && pt[0] <= b.max[0] + t && pt[1] >= b.min[1] - t && pt[1] <= b.max[1] + t;
  for (const p of present.filter(x => x.kind === 'column')) {
    const key = p.row.source_key;
    const b = p.item.bbox;
    const pt = p.item.location?.point ?? (b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : null);
    if (!pt || !b) { add(key, 'support', 'fail', 'footing', null, null, 'no location/bbox'); continue; }
    const hs = p.row.host_supports ?? [];
    const cands = hs.length ? present.filter(x => hs.includes(x.row.source_key) && bboxOk(x)) : footings;
    const hit = cands.filter(f => inXY(pt, f.item.bbox, tol.sxy));
    if (!hit.length) { add(key, 'support', 'fail', hs.length ? hs.join('|') : 'any footing', fmtPt([pt[0], pt[1]]), null, 'column XY outside support bbox'); continue; }
    const best = hit.map(f => Math.abs(b.min[2] - f.item.bbox.max[2])).sort((x, y) => x - y)[0];
    add(key, 'support', best <= tol.sz + 1e-9 ? 'pass' : 'fail', 'base z = support top', r3(b.min[2]), r3(best), 'delta = smallest |column base - support top|');
  }
  const allowed = new Set((at.allowed_unsupported_ends ?? []).map(a => (typeof a === 'string' ? a : `${a.source_key}#${a.end}`)));
  const supportsFor = self => present.filter(x => x.row.source_key !== self && ['column', 'footing', 'wall', 'beam'].includes(x.kind) && bboxOk(x));
  for (const p of present.filter(x => x.kind === 'beam')) {
    const key = p.row.source_key;
    const ends = p.item.location?.start && p.item.location?.end ? [p.item.location.start, p.item.location.end] : null;
    if (!ends || ends.some(e => e.length < 3)) { add(key, 'support_end', 'fail', 'support', null, null, 'beam endpoints missing in readback'); continue; }
    ends.forEach((pt, i) => {
      // Broad-phase bbox candidate test (semantics of verifyBeamEndpoints, with separate XY/Z tolerances).
      const sups = supportsFor(key);
      const cands = sups.filter(s => inXY(pt, s.item.bbox, tol.sxy) && pt[2] >= s.item.bbox.min[2] - tol.sz && pt[2] <= s.item.bbox.max[2] + tol.sz);
      const exempt = allowed.has(`${key}#${i}`) || allowed.has(key);
      if (cands.length) add(key, 'support_end', 'pass', 'support', cands.map(c => c.row.source_key).slice(0, 3).join('|'), 0, `end ${i}; contact: "bbox-candidate"`);
      else if (exempt) add(key, 'support_end', 'warn', 'support', 'none', null, `end ${i} unsupported but listed in allowed_unsupported_ends`);
      else {
        let gap = Infinity;
        for (const s of sups) {
          const b = s.item.bbox;
          gap = Math.min(gap, Math.hypot(Math.max(b.min[0] - pt[0], 0, pt[0] - b.max[0]), Math.max(b.min[1] - pt[1], 0, pt[1] - b.max[1]), Math.max(b.min[2] - pt[2], 0, pt[2] - b.max[2])));
        }
        add(key, 'support_end', 'fail', 'support', 'none', Number.isFinite(gap) ? r3(gap) : null, `end ${i} unsupported (delta = nearest bbox gap mm); contact: "bbox-candidate"`);
      }
    });
  }

  // ---- 8. footing overlap ------------------------------------------------
  for (let i = 0; i < footings.length; i++) for (let j = i + 1; j < footings.length; j++) {
    const a = footings[i], b = footings[j];
    if (a.row.group && a.row.group === b.row.group) continue;
    const A = a.item.bbox, B = b.item.bbox;
    const ox = Math.min(A.max[0], B.max[0]) - Math.max(A.min[0], B.min[0]);
    const oy = Math.min(A.max[1], B.max[1]) - Math.max(A.min[1], B.min[1]);
    const oz = Math.min(A.max[2], B.max[2]) - Math.max(A.min[2], B.min[2]);
    if (ox > 0 && oy > 0 && oz > tol.z && ox * oy > tol.overlap)
      add(`${a.row.source_key} x ${b.row.source_key}`, 'overlap', 'warn', `<= ${tol.overlap} mm2`, r3(ox * oy), r3(ox * oy), 'footing bboxes overlap in plan (possible double-count)');
  }

  const totals = {};
  for (const r of rows) {
    const t = (totals[r.check.split(':')[0]] ??= {pass: 0, fail: 0, warn: 0, skip: 0});
    t[r.status]++;
  }
  const failures = rows.filter(r => r.status === 'fail');
  return {
    ok: failures.length === 0,
    summary: {rows: rows.length, fail: failures.length, warn: rows.filter(r => r.status === 'warn').length, tolerances: tol, totals},
    notes, failures, warnings: rows.filter(r => r.status === 'warn'), rows,
  };
}

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) { args.bad = true; break; }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (args.bad || !args.manifest || !args.readback || Object.keys(args).some(k => !['manifest', 'readback', 'sources', 'out'].includes(k))) {
    console.error('Usage: node qa_model.mjs --manifest m.json --readback r.json [--sources s.json] [--out report.json]');
    process.exitCode = 2;
  } else {
    try {
      const report = runQa(await readJson(args.manifest), await readJson(args.readback), args.sources ? await readJson(args.sources) : undefined);
      if (args.out) await writeFile(args.out, JSON.stringify(report, null, 1));
      const fields = ['source_key', 'check', 'expected', 'actual', 'delta', 'note'];
      let limit = 20, text;
      do {
        text = JSON.stringify({ok: report.ok, report: args.out ? resolve(args.out) : undefined, summary: report.summary, notes: report.notes,
          failures: summarize(report.failures, {limit, fields})});
        limit -= 5;
      } while (text.length > 8000 && limit >= 0);
      console.log(text);
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 2; }
  }
}
