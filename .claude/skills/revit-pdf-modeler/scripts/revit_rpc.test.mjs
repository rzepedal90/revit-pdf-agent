// Original to this repository. Guard/argument logic and wire framing of revit_rpc.mjs against a mock socket server.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs, applyGuards, isReadOnlyCommand, sendCommand, main} from './revit_rpc.mjs';

/** Mock plugin: records the raw bytes of each request, replies in two chunks, returns reply(request). */
function mockServer(reply) {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      let req;
      try { req = JSON.parse(buf); } catch { return; }
      received.push({raw: buf, req});
      buf = '';
      const text = JSON.stringify({id: req.id, ...reply(req)});
      const mid = Math.floor(text.length / 2);
      socket.write(text.slice(0, mid));
      setTimeout(() => socket.write(text.slice(mid)), 20);
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({server, received, port: server.address().port})));
}

test('read-only allowlist', () => {
  for (const c of ['get_spatial_reference', 'get_elements_info', 'find_elements', 'find_by_source_key', 'query_where', 'say_hello']) {
    assert.ok(isReadOnlyCommand(c), c);
  }
  for (const c of ['build_elements', 'set_parameter', 'send_code_to_revit', 'delete_element', 'getaway', 'query_where2']) {
    assert.ok(!isReadOnlyCommand(c), c);
  }
});

test('parseArgs: defaults, options and errors', () => {
  const o = parseArgs(['get_elements_info', 'p.json']);
  assert.deepEqual([o.host, o.port, o.timeoutMs, o.allowWrite, o.commit], ['localhost', 8080, 120000, false, false]);
  const w = parseArgs(['build_elements', '-', '--out', 'o.json', '--allow-write', '--commit', '--port', '9000', '--host', '127.0.0.1']);
  assert.deepEqual([w.paramsSource, w.out, w.allowWrite, w.commit, w.port, w.host], ['-', 'o.json', true, true, 9000, '127.0.0.1']);
  assert.throws(() => parseArgs(['only_one']), /usage/);
  assert.throws(() => parseArgs(['a', 'b', '--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['a', 'b', '--out']), /needs a value/);
  assert.throws(() => parseArgs(['a', 'b', '--port', 'x']), /invalid --port/);
  assert.throws(() => parseArgs(['Bad-Name', 'b']), /invalid command/);
});

test('guards: writes need --allow-write; build_elements needs dryRun:true unless --commit', () => {
  assert.deepEqual(applyGuards('get_elements_info', {ids: [1]}), {ids: [1]});
  assert.throws(() => applyGuards('set_parameter', {}), /--allow-write/);
  assert.deepEqual(applyGuards('set_parameter', {a: 1}, {allowWrite: true}), {a: 1});
  assert.throws(() => applyGuards('build_elements', {dryRun: true}), /--allow-write/);
  assert.deepEqual(applyGuards('build_elements', {dryRun: true, x: 1}, {allowWrite: true}), {dryRun: true, x: 1});
  assert.throws(() => applyGuards('build_elements', {dryRun: false}, {allowWrite: true}), /dryRun:true/);
  assert.throws(() => applyGuards('build_elements', {}, {allowWrite: true}), /dryRun:true/);
  assert.deepEqual(applyGuards('build_elements', {dryRun: true, x: 1}, {allowWrite: true, commit: true}), {dryRun: false, x: 1});
  assert.throws(() => applyGuards('build_elements', {dryRun: true}, {commit: true}), /--allow-write/);
  assert.throws(() => applyGuards('get_elements_info', {}, {commit: true}), /only applies to build_elements/);
  assert.throws(() => applyGuards('say_hello', [], {}), /JSON object/);
});

test('sendCommand frames a raw JSON-RPC 2.0 request and reassembles a chunked reply', async () => {
  const {server, received, port} = await mockServer(() => ({result: {hello: 'revit'}}));
  try {
    const result = await sendCommand({host: '127.0.0.1', port, command: 'say_hello', params: {message: 'hi'}});
    assert.deepEqual(result, {hello: 'revit'});
    assert.equal(received.length, 1);
    const {raw, req} = received[0];
    assert.equal(raw, JSON.stringify({jsonrpc: '2.0', method: 'say_hello', params: {message: 'hi'}, id: req.id}));
    assert.match(req.id, /^\d{13}\d+$/);
  } finally { server.close(); }
});

test('sendCommand surfaces Revit errors, timeouts and connection failures', async () => {
  const err = await mockServer(() => ({error: {message: 'boom'}}));
  await assert.rejects(sendCommand({host: '127.0.0.1', port: err.port, command: 'get_x'}), /boom/);
  err.server.close();
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  await assert.rejects(sendCommand({host: '127.0.0.1', port: silent.address().port, command: 'get_x', timeoutMs: 80}), /timed out/);
  silent.close();
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const freePort = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(sendCommand({host: '127.0.0.1', port: freePort, command: 'get_x'}), /Cannot talk to Revit/);
});

test('main: dry-run build_elements sends dryRun:true, writes full JSON to --out, prints a bounded summary', async () => {
  const full = {ok: true, dryRun: true, committed: false, manifestHash: 'h', counts: {created: 2, updated: 0, skipped: 0, failed: 0},
    items: Array.from({length: 300}, (_, i) => ({sourceKey: `k${i}`, action: 'created'})),
    warnings: [{message: 'w1', severity: 'warning'}], errors: []};
  const {server, received, port} = await mockServer(() => ({result: full}));
  const dir = mkdtempSync(join(tmpdir(), 'rpc-'));
  const paramsFile = join(dir, 'p.json');
  const outFile = join(dir, 'o.json');
  writeFileSync(paramsFile, JSON.stringify({dryRun: true, mode: 'upsert', elements: []}));
  const lines = [];
  const errs = [];
  try {
    const code = await main(['build_elements', paramsFile, '--allow-write', '--out', outFile, '--port', String(port), '--host', '127.0.0.1'],
      {stdout: (s) => lines.push(s), stderr: (s) => errs.push(s)});
    assert.equal(code, 0, errs.join());
    assert.equal(received[0].req.params.dryRun, true);
    assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).items.length, 300);
    assert.ok(lines[0].length < 8000);
    const summary = JSON.parse(lines[0]);
    assert.equal(summary.counts.created, 2);
    assert.equal(summary.warnings.count, 1);
    assert.ok(!lines[0].includes('"k299"'));
  } finally { server.close(); }
});

test('main: --commit flips dryRun false; blocked invocations never touch the network', async () => {
  const {server, received, port} = await mockServer(() => ({result: {ok: true, committed: true}}));
  const dir = mkdtempSync(join(tmpdir(), 'rpc-'));
  const paramsFile = join(dir, 'p.json');
  writeFileSync(paramsFile, JSON.stringify({dryRun: true, elements: []}));
  const lines = [];
  const errs = [];
  const io = {stdout: (s) => lines.push(s), stderr: (s) => errs.push(s)};
  try {
    assert.equal(await main(['build_elements', paramsFile, '--port', String(port), '--host', '127.0.0.1'], io), 1);
    assert.match(errs.pop(), /--allow-write/);
    writeFileSync(paramsFile, JSON.stringify({dryRun: false, elements: []}));
    assert.equal(await main(['build_elements', paramsFile, '--allow-write', '--port', String(port), '--host', '127.0.0.1'], io), 1);
    assert.match(errs.pop(), /dryRun:true/);
    assert.equal(received.length, 0);
    assert.equal(await main(['build_elements', '-', '--allow-write', '--commit', '--port', String(port), '--host', '127.0.0.1'],
      {...io, readStdin: () => JSON.stringify({dryRun: true, elements: []})}), 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].req.params.dryRun, false);
  } finally { server.close(); }
});
