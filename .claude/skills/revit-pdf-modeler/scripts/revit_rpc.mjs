#!/usr/bin/env node
// Original to this repository. Minimal scriptable client for the Revit plugin socket, replicating the wire protocol of
// server/src/utils/SocketClient.ts: one raw JSON-RPC 2.0 request object per write (no length prefix, no delimiter),
// {"jsonrpc":"2.0","method":<command>,"params":<object>,"id":<string>}; the reply is one JSON object
// ({"id","result"} or {"id","error":{"message"}}) that may arrive in several TCP chunks, so the buffer is re-parsed
// until it is complete JSON. Default endpoint localhost:8080 (ConnectionManager.ts); timeout 120 s like SocketClient.
//
// Usage: node revit_rpc.mjs <command> <params.json|-> [--out file] [--allow-write] [--commit]
//                           [--host h] [--port p] [--timeout-ms n]
//        node revit_rpc.mjs readback <prefix...> --out <dir> [--page-size 2000] [--batch 150]
// --chunk-bytes N (build_elements only, default off): split payload.elements into sequential requests whose JSON-RPC
// envelope stays below N bytes; counts/warnings/errors/items are aggregated, the run stops at the first failed chunk,
// and --out gets the aggregate (with a per-chunk list). readback: pages find_by_source_key per prefix, fetches
// get_elements_info in batches, writes <dir>/sources.json and <dir>/readback.json for qa_model.mjs.
// Guards: read-only commands (get_*, find_*, query_where, say_hello) run by default; every other command needs
// --allow-write; build_elements must carry dryRun:true unless --commit is given (--commit sends dryRun:false).
// The full JSON result goes to --out; stdout gets a bounded summary only, so payloads/readbacks stay out of LLM context.
import * as net from 'node:net';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarize} from './json_summary.mjs';

export const DEFAULTS = {host: 'localhost', port: 8080, timeoutMs: 120000};
const READ_ONLY = /^(get_.+|find_.+|query_where|say_hello)$/;

export function isReadOnlyCommand(command) {
  return READ_ONLY.test(command);
}

export function parseArgs(argv) {
  const o = {host: DEFAULTS.host, port: DEFAULTS.port, timeoutMs: DEFAULTS.timeoutMs, allowWrite: false, commit: false, out: undefined, chunkBytes: 0, pageSize: 2000, batch: 150};
  const positional = [];
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-write') o.allowWrite = true;
    else if (a === '--commit') o.commit = true;
    else if (a === '--out') o.out = value(i++, a);
    else if (a === '--host') o.host = value(i++, a);
    else if (a === '--port') o.port = Number(value(i++, a));
    else if (a === '--timeout-ms') o.timeoutMs = Number(value(i++, a));
    else if (a === '--chunk-bytes') o.chunkBytes = Number(value(i++, a));
    else if (a === '--page-size') o.pageSize = Number(value(i++, a));
    else if (a === '--batch') o.batch = Number(value(i++, a));
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional[0] === 'readback') {
    o.command = 'readback';
    o.prefixes = positional.slice(1);
    if (!o.prefixes.length) throw new Error('readback needs at least one source-key prefix');
    if (!o.out) throw new Error('readback needs --out <dir>');
    for (const [k, max] of [['pageSize', 5000], ['batch', 1000]]) {
      if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > max) throw new Error(`invalid --${k === 'pageSize' ? 'page-size' : 'batch'}`);
    }
    return o;
  }
  if (!Number.isFinite(o.chunkBytes) || o.chunkBytes < 0) throw new Error('invalid --chunk-bytes');
  if (positional.length !== 2) throw new Error('usage: revit_rpc.mjs <command> <params.json|-> [--out file] [--allow-write] [--commit]');
  [o.command, o.paramsSource] = positional;
  if (!/^[a-z][a-z0-9_]*$/.test(o.command)) throw new Error(`invalid command name: ${o.command}`);
  if (o.chunkBytes && o.command !== 'build_elements') throw new Error('--chunk-bytes only applies to build_elements');
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('invalid --port');
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs < 1) throw new Error('invalid --timeout-ms');
  return o;
}

/**
 * Enforce the write guards and return the params actually sent. Throws on violation.
 * build_elements: dryRun must be exactly true unless commit; with commit the payload is sent with dryRun:false.
 */
export function applyGuards(command, params, {allowWrite = false, commit = false} = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be a JSON object');
  if (commit && command !== 'build_elements') throw new Error('--commit only applies to build_elements');
  if (isReadOnlyCommand(command)) return params;
  if (!allowWrite) throw new Error(`'${command}' is not read-only; pass --allow-write to run it`);
  if (command === 'build_elements') {
    if (commit) return {...params, dryRun: false};
    if (params.dryRun !== true) throw new Error('build_elements requires dryRun:true in the payload unless --commit is passed');
  }
  return params;
}

/** Send one command; resolves with response.result, rejects with the Revit error message / timeout / socket error. */
export function sendCommand({host = DEFAULTS.host, port = DEFAULTS.port, command, params = {}, timeoutMs = DEFAULTS.timeoutMs}) {
  return new Promise((resolvePromise, reject) => {
    const id = Date.now().toString() + Math.random().toString().substring(2, 8);
    const socket = new net.Socket();
    let buffer = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Command timed out after ${timeoutMs} ms: ${command}`)), timeoutMs);
    socket.on('error', (e) => finish(reject, new Error(`Cannot talk to Revit at ${host}:${port}: ${e.message}`)));
    socket.on('close', () => finish(reject, new Error('Connection closed before a complete response')));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let response;
      try { response = JSON.parse(buffer); } catch { return; } // incomplete: wait for more
      buffer = '';
      if ((response.id || 'default') !== id) return;
      if (response.error) finish(reject, new Error(response.error.message || 'Unknown error from Revit'));
      else finish(resolvePromise, response.result);
    });
    socket.connect(port, host, () => {
      socket.write(JSON.stringify({jsonrpc: '2.0', method: command, params, id}));
    });
  });
}

const envelopeBytes = (command, params) =>
  Buffer.byteLength(JSON.stringify({jsonrpc: '2.0', method: command, params, id: '0'.repeat(19)}));

/** Greedy split of params.elements into groups whose request envelope stays <= maxBytes (a single oversized element goes alone). */
export function chunkElements(params, maxBytes, command = 'build_elements') {
  const elements = Array.isArray(params.elements) ? params.elements : [];
  const base = envelopeBytes(command, {...params, elements: []});
  const chunks = [];
  let cur = [];
  let size = base;
  for (const el of elements) {
    const add = Buffer.byteLength(JSON.stringify(el)) + 1; // element + comma
    if (cur.length && size + add > maxBytes) { chunks.push(cur); cur = []; size = base; }
    cur.push(el);
    size += add;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

/** Sequential chunked build_elements; stops at the first failed chunk (ok:false or thrown error). */
export async function runChunked({host, port, params, maxBytes, timeoutMs, send = sendCommand}) {
  const chunks = chunkElements(params, maxBytes);
  const agg = {ok: true, dryRun: undefined, committed: false, manifestHash: params.manifestHash, counts: {}, warnings: [], errors: [], items: [], chunks: []};
  for (let i = 0; i < chunks.length; i++) {
    const elements = chunks[i];
    let r;
    try {
      r = await send({host, port, command: 'build_elements', params: {...params, elements}, timeoutMs});
    } catch (error) {
      agg.ok = false;
      agg.errors.push({message: `chunk ${i + 1}/${chunks.length} failed: ${error.message}`});
      agg.chunks.push({index: i + 1, elements: elements.length, ok: false, error: error.message});
      agg.stoppedAtChunk = i + 1;
      break;
    }
    agg.dryRun = r.dryRun ?? agg.dryRun;
    agg.committed = agg.committed || r.committed === true;
    agg.manifestHash = r.manifestHash ?? agg.manifestHash;
    for (const [k, v] of Object.entries(r.counts ?? {})) if (typeof v === 'number') agg.counts[k] = (agg.counts[k] ?? 0) + v;
    agg.warnings.push(...(r.warnings ?? []));
    agg.errors.push(...(r.errors ?? []));
    agg.items.push(...(r.items ?? []));
    agg.chunks.push({index: i + 1, elements: elements.length, ok: r.ok !== false, committed: r.committed === true});
    if (r.ok === false) { agg.ok = false; agg.stoppedAtChunk = i + 1; break; }
  }
  agg.chunkCount = chunks.length;
  return agg;
}

/** Page find_by_source_key per prefix, then get_elements_info in batches. Returns {sources, readback}. */
export async function readbackAll({host, port, prefixes, pageSize = 2000, batch = 150, timeoutMs, send = sendCommand}) {
  const matches = [];
  const duplicates = [];
  let total = 0;
  for (const prefix of prefixes) {
    let offset = 0;
    for (;;) {
      const r = await send({host, port, command: 'find_by_source_key', params: {prefix, limit: pageSize, offset}, timeoutMs});
      matches.push(...(r.matches ?? []));
      if (offset === 0) { duplicates.push(...(r.duplicates ?? [])); total += r.total ?? 0; }
      if (!r.hasMore || !(r.matches?.length)) break;
      offset = r.nextOffset ?? offset + r.matches.length;
    }
  }
  const ids = matches.map((m) => m.id);
  const items = [];
  const notFound = [];
  for (let i = 0; i < ids.length; i += batch) {
    const r = await send({host, port, command: 'get_elements_info', params: {ids: ids.slice(i, i + batch)}, timeoutMs});
    items.push(...(r.items ?? []));
    notFound.push(...(r.notFound ?? []));
  }
  return {
    sources: {total, hasMore: false, matches, notFound: [], duplicates},
    readback: {count: items.length, items, notFound},
  };
}

function readParams(source, readStdin) {
  const text = source === '-' ? readStdin() : readFileSync(source, 'utf8');
  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Bounded stdout summary; build_elements gets its counts/warnings/errors surfaced explicitly. */
export function summarizeResult(command, result, outFile) {
  const out = {command, artifact: outFile ? resolve(outFile) : null};
  if (command === 'build_elements' && result && typeof result === 'object') {
    Object.assign(out, {
      ok: result.ok, chunks: result.chunkCount, stoppedAtChunk: result.stoppedAtChunk, dryRun: result.dryRun, committed: result.committed, manifestHash: result.manifestHash, counts: result.counts,
      warnings: Array.isArray(result.warnings) ? summarize(result, {path: 'warnings', limit: 10}) : null,
      errors: Array.isArray(result.errors) ? summarize(result, {path: 'errors', limit: 10}) : null,
    });
  } else {
    Object.assign(out, summarize(result ?? null, {limit: 5}));
  }
  let text = JSON.stringify(out);
  if (text.length > 8000) text = JSON.stringify({command, artifact: out.artifact, note: 'summary truncated; read the --out file with json_summary.mjs'});
  return text;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((s) => console.log(s));
  const stderr = io.stderr ?? ((s) => console.error(s));
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
  try {
    const opts = parseArgs(argv);
    if (opts.command === 'readback') {
      const {sources, readback} = await readbackAll({host: opts.host, port: opts.port, prefixes: opts.prefixes, pageSize: opts.pageSize, batch: opts.batch, timeoutMs: opts.timeoutMs});
      mkdirSync(opts.out, {recursive: true});
      writeFileSync(join(opts.out, 'sources.json'), JSON.stringify(sources));
      writeFileSync(join(opts.out, 'readback.json'), JSON.stringify(readback));
      stdout(JSON.stringify({command: 'readback', dir: resolve(opts.out), sourceKeys: sources.matches.length, total: sources.total,
        duplicates: sources.duplicates.length, info: readback.items.length, notFound: readback.notFound.length}));
      return 0;
    }
    const params = applyGuards(opts.command, readParams(opts.paramsSource, readStdin), opts);
    const result = opts.chunkBytes
      ? await runChunked({host: opts.host, port: opts.port, params, maxBytes: opts.chunkBytes, timeoutMs: opts.timeoutMs})
      : await sendCommand({host: opts.host, port: opts.port, command: opts.command, params, timeoutMs: opts.timeoutMs});
    if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    stdout(summarizeResult(opts.command, result, opts.out));
    return result?.ok === false && opts.chunkBytes ? 1 : 0;
  } catch (error) {
    stderr(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
