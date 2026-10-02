#!/usr/bin/env node
// Original to this repository. Compiles a FROZEN revit-pdf-modeler manifest (mode EXECUTE, manifest_frozen true)
// into deterministic `build_elements` payload files. Uses hash() from execution_runner.mjs, which is adapted from:
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
//
// Usage: node compile_build_payload.mjs <manifest.json> [--out-dir dir] [--chunk 500] [--no-dry-run-flag]
// Writes <out-dir>/build_payload_NNN_<kind>.json (one stage per file, <=500 elements) and compile_summary.json,
// prints a bounded summary. Payload files carry dryRun:true; revit_rpc.mjs --commit flips it at send time.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './execution_runner.mjs';
import {summarize} from './json_summary.mjs';
import {validateManifest, KIND_BY_CATEGORY} from './validate_manifest.mjs';

export const STAGES = ['grid', 'footing', 'column', 'beam', 'wall'];
export const MAX_PER_CHUNK = 500;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const xy = ([x, y]) => ({x, y});

function toElement(row, kind, type) {
  const g = row.geometry_mm;
  const z = row.z_constraints;
  const el = {sourceKey: row.source_key, kind};
  if (kind === 'grid') {
    Object.assign(el, {name: row.name, start: xy(g.start), end: xy(g.end)});
  } else {
    el.familyName = type.family;
    el.typeName = type.type;
    if (kind === 'footing') {
      Object.assign(el, {point: {x: g.x, y: g.y}, rotationDeg: g.rotation_deg, level: z.level, offsetMm: z.offset_mm});
    } else if (kind === 'column') {
      Object.assign(el, {
        point: {x: g.x, y: g.y}, rotationDeg: g.rotation_deg,
        baseLevel: z.base_level, baseOffsetMm: z.base_offset_mm, topLevel: z.top_level, topOffsetMm: z.top_offset_mm,
      });
    } else if (kind === 'beam') {
      Object.assign(el, {
        start: xy(g.start), end: xy(g.end), level: z.level,
        startOffsetMm: z.start_offset_mm, endOffsetMm: z.end_offset_mm, zJustification: z.z_justification,
      });
      if (row.structural_usage) el.structuralUsage = row.structural_usage;
    } else {
      Object.assign(el, {
        start: xy(g.start), end: xy(g.end), baseLevel: z.base_level, baseOffsetMm: z.base_offset_mm,
        structural: row.structural ?? true, locationLine: 'center',
      });
      if (z.height_mm !== undefined) el.heightMm = z.height_mm;
      else Object.assign(el, {topLevel: z.top_level, topOffsetMm: z.top_offset_mm});
    }
  }
  if (Array.isArray(row.parameters) && row.parameters.length) el.parameters = row.parameters;
  return el;
}

/** Pure compiler. Throws on an invalid / unfrozen / non-EXECUTE manifest. */
export function compileBuildPayloads(manifest, {maxPerChunk = MAX_PER_CHUNK, dryRun = true} = {}) {
  if (!Number.isInteger(maxPerChunk) || maxPerChunk < 1 || maxPerChunk > MAX_PER_CHUNK) {
    throw new Error(`chunk size must be an integer 1..${MAX_PER_CHUNK}`);
  }
  if (manifest?.mode !== 'EXECUTE' || manifest?.manifest_frozen !== true) {
    throw new Error('compile requires mode EXECUTE and manifest_frozen true');
  }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`manifest is invalid:\n- ${errors.slice(0, 20).join('\n- ')}`);

  const types = new Map(manifest.type_manifest.map((t) => [t.source_key, t]));
  const skipped = [];
  const byStage = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const row of manifest.element_manifest) {
    if (row.status !== 'resolved') {
      skipped.push({sourceKey: row.source_key, status: row.status, category: row.category});
      continue;
    }
    const kind = KIND_BY_CATEGORY[row.category];
    byStage[kind].push(toElement(row, kind, types.get(row.type_key)));
  }
  skipped.sort((a, b) => cmp(a.sourceKey, b.sourceKey));

  const manifestHash = hash(manifest);
  const transform = manifest.coordinate_basis.transform_to_model;
  const payloads = [];
  for (const stage of STAGES) {
    const elements = byStage[stage].sort((a, b) => cmp(a.sourceKey, b.sourceKey));
    for (let i = 0; i < elements.length; i += maxPerChunk) {
      const index = payloads.length + 1;
      payloads.push({
        stage,
        file: `build_payload_${String(index).padStart(3, '0')}_${stage}.json`,
        payload: {
          dryRun, mode: 'upsert', manifestHash,
          transform: {originMm: {x: transform.originMm.x, y: transform.originMm.y}, rotationDeg: transform.rotationDeg},
          elements: elements.slice(i, i + maxPerChunk),
        },
      });
    }
  }
  const counts = Object.fromEntries(STAGES.map((s) => [s, byStage[s].length]));
  return {manifestHash, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), payloads, skipped};
}

export function main(argv = process.argv.slice(2), out = (line) => console.log(line)) {
  const args = {outDir: 'payloads', chunk: MAX_PER_CHUNK};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') args.outDir = argv[++i];
    else if (argv[i] === '--chunk') args.chunk = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new Error('usage: compile_build_payload.mjs manifest.json [--out-dir dir] [--chunk 1..500]');
  const manifest = JSON.parse(readFileSync(positional[0], 'utf8').replace(/^﻿/, ''));
  const result = compileBuildPayloads(manifest, {maxPerChunk: args.chunk});
  const dir = resolve(args.outDir);
  mkdirSync(dir, {recursive: true});
  const files = result.payloads.map(({stage, file, payload}) => {
    writeFileSync(join(dir, file), JSON.stringify(payload, null, 2) + '\n');
    return {file, stage, elements: payload.elements.length, payloadHash: hash(payload)};
  });
  const summary = {manifestHash: result.manifestHash, counts: result.counts, total: result.total, files, skipped: result.skipped};
  writeFileSync(join(dir, 'compile_summary.json'), JSON.stringify(summary, null, 2) + '\n');
  out(JSON.stringify({
    outDir: dir, manifestHash: result.manifestHash, counts: result.counts, total: result.total,
    files: summarize(summary, {path: 'files', limit: 20}),
    skipped: summarize(summary, {path: 'skipped', limit: 10}),
  }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
