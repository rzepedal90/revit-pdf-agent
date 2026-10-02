#!/usr/bin/env node
// Original to this repository. Minimal scriptable client for the Revit plugin socket, replicating the wire protocol of
// server/src/utils/SocketClient.ts: one raw JSON-RPC 2.0 request object per write (no length prefix, no delimiter),
// {"jsonrpc":"2.0","method":<command>,"params":<object>,"id":<string>}; the reply is one JSON object
// ({"id","result"} or {"id","error":{"message"}}) that may arrive in several TCP chunks, so the buffer is re-parsed
// until it is complete JSON. Default endpoint localhost:8080 (ConnectionManager.ts); timeout 120 s like SocketClient.
//
// Usage: node revit_rpc.mjs <command> <params.json|-> [--out file] [--allow-write] [--commit]
//                           [--host h] [--port p] [--timeout-ms n]
// Guards: read-only commands (get_*, find_*, query_where, say_hello) run by default; every other command needs
// --allow-write; build_elements must carry dryRun:true unless --commit is given (--commit sends dryRun:false).
// The full JSON result goes to --out; stdout gets a bounded summary only, so payloads/readbacks stay out of LLM context.
import * as net from 'node:net';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarize} from './json_summary.mjs';

export const DEFAULTS = {host: 'localhost', port: 8080, timeoutMs: 120000};
const READ_ONLY = /^(get_.+|find_.+|query_where|say_hello)$/;

export function isReadOnlyCommand(command) {
  return READ_ONLY.test(command);
}

export function parseArgs(argv) {
  const o = {host: DEFAULTS.host, port: DEFAULTS.port, timeoutMs: DEFAULTS.timeoutMs, allowWrite: false, commit: false, out: undefined};
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
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Error('usage: revit_rpc.mjs <command> <params.json|-> [--out file] [--allow-write] [--commit]');
  [o.command, o.paramsSource] = positional;
  if (!/^[a-z][a-z0-9_]*$/.test(o.command)) throw new Error(`invalid command name: ${o.command}`);
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

function readParams(source, readStdin) {
  const text = source === '-' ? readStdin() : readFileSync(source, 'utf8');
  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Bounded stdout summary; build_elements gets its counts/warnings/errors surfaced explicitly. */
export function summarizeResult(command, result, outFile) {
  const out = {command, artifact: outFile ? resolve(outFile) : null};
  if (command === 'build_elements' && result && typeof result === 'object') {
    Object.assign(out, {
      ok: result.ok, dryRun: result.dryRun, committed: result.committed, manifestHash: result.manifestHash, counts: result.counts,
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
    const params = applyGuards(opts.command, readParams(opts.paramsSource, readStdin), opts);
    const result = await sendCommand({host: opts.host, port: opts.port, command: opts.command, params, timeoutMs: opts.timeoutMs});
    if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    stdout(summarizeResult(opts.command, result, opts.out));
    return 0;
  } catch (error) {
    stderr(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
