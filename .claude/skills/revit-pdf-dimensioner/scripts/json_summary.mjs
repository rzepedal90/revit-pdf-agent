#!/usr/bin/env node
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
/** Bounded JSON inspection. Never dump an entire minified evidence file. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function summarize(value, {path = '', limit = 5, fields = []} = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 20) throw Error('Limit must be 0..20');
  let selected = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (selected == null || !Object.hasOwn(selected, key)) throw Error(`Missing JSON path: ${path}`);
    selected = selected[key];
  }
  const preview = item => {
    if (item == null || typeof item !== 'object') return String(item).slice(0, 200);
    const keys = fields.length ? fields : Object.keys(item).slice(0, 8);
    return Object.fromEntries(keys.map(k => {
      const v = item[k];
      return [k, Array.isArray(v) ? {kind:'array',count:v.length} :
        v && typeof v === 'object' ? {kind:'object',keys:Object.keys(v).slice(0,8)} :
        typeof v === 'string' ? v.slice(0,200) : v];
    }));
  };
  return Array.isArray(selected) ? {path,kind:'array',count:selected.length,sample:selected.slice(0,limit).map(preview)} :
    {path,kind:typeof selected,preview:preview(selected)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file,path='',limit='5',fields=''] = process.argv.slice(2);
    if (!file) throw Error('Usage: node json_summary.mjs file.json [dot.path] [limit 0..20] [field1,field2]');
    const bytes = await readFile(file);
    const output = {artifact:resolve(file),bytes:bytes.length,...summarize(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),
      {path,limit:Number(limit),fields:fields.split(',').filter(Boolean)})};
    const text = JSON.stringify(output);
    if (text.length > 8000) throw Error('Summary exceeds 8000 characters; select fewer fields/rows');
    console.log(text);
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
