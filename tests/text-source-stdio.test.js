import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Platform } from '../src/platform.js';

test('real stdio exposes source CAS, snapshot approval and isolated phrase upload/status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-source-stdio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = 'p.' + createHash('sha256').update('开始').digest('hex'), fingerprint = 'c'.repeat(64);
  await writeFile(join(directory, 'original.json'), JSON.stringify({ [key]: '开始' }));
  await writeFile(join(directory, 'en.json'), JSON.stringify({ [key]: 'Start' }));
  const calls = [], sources = { keys: null, phrases: null }, files = { keys: {}, phrases: {} };
  let conflict = false, scanFails = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = new URL(request.url, 'http://localhost'), use = url.searchParams.get('use') ?? 'keys';
    calls.push({ path: request.url, method: request.method, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer ' + 'b'.repeat(64)) { response.statusCode = 401; return response.end('{"error":"Unauthorized","code":"AUTH_REQUIRED"}'); }
    if (url.pathname === '/api/developer/text-source/my-game') {
      if (request.method === 'PUT') {
        if (conflict || body.expectedRevision !== (sources[use]?.revision ?? 0)) {
          response.statusCode = 409; return response.end('{"error":"Config changed","code":"SOURCE_CHANGED"}');
        }
        sources[use] = { ...body, revision: (sources[use]?.revision ?? 0) + 1, source_fingerprint: fingerprint, lease_token: 'PRIVATE', pending_entries: { [key]: '开始' }, last_result: 'pending' };
      }
      if (request.method === 'POST' && body.action === 'scan') {
        if (scanFails) { response.statusCode = 503; return response.end('{"error":"Scan failed","code":"SCAN_FAILED"}'); }
        sources[use].last_result = 'partial';
      }
      if (request.method === 'POST' && body.action === 'approve') sources[use].pending_entries = {};
      return response.end(JSON.stringify({ config: sources[use], engine: null, status: [], integration: { state: 'not_verified', message: 'Verify SDK/Godot rendering' } }));
    }
    if (url.pathname === '/api/developer/language-files/my-game') {
      if (request.method === 'PUT') files[use][body.locale] = { entries: body.entries, source: body.kind === 'original' ? 'original' : 'ai_creator' };
      return response.end(JSON.stringify({ engine: null, status: Object.keys(files[use]).map(locale => ({ locale, state: 'ready', total: 1, done: 1, missing: [], stale: [], edited: 0 })), files: files[use] }));
    }
    response.statusCode = 404; response.end('{"error":"Not found"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const platform = new Platform({ origin, configDirectory: join(directory, '.config', '1gp-studio') });
  await mkdir(platform.directory, { recursive: true }); await writeFile(platform.file, JSON.stringify({ token: 'b'.repeat(64) }));
  const client = new Client({ name: 'text-source-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/server.js')], env: { ...process.env, ONEGP_PLATFORM_URL: origin, HOME: directory, USERPROFILE: directory }, stderr: 'pipe' }));
  t.after(() => client.close());
  const invoke = async (name, args) => {
    const answer = await client.callTool({ name, arguments: args }); return { ...answer, data: JSON.parse(answer.content[0].text) };
  };
  const tools = (await client.listTools()).tools;
  for (const name of ['get_game_text_source', 'configure_game_text_source', 'approve_game_text_candidates']) assert.ok(tools.some(tool => tool.name === name));
  const setup = { gameSlug: 'my-game', use: 'phrases', enabled: true, locale: 'zh', files: ['index.html'] };
  const configured = await invoke('configure_game_text_source', setup);
  assert.equal(configured.isError, false); assert.equal(configured.data.config.last_result, 'partial');
  assert.equal(configured.data.engine, null); assert.equal(configured.data.integration.state, 'not_verified');
  assert.equal(JSON.stringify(configured).includes('PRIVATE'), false);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT', 'POST']); assert.equal(calls[1].body.expectedRevision, 0);
  const approved = await invoke('approve_game_text_candidates', { gameSlug: 'my-game', keys: [key], expectedRevision: 1, expectedFingerprint: fingerprint });
  assert.equal(approved.isError, false); assert.deepEqual(calls.at(-1).body, { action: 'approve', keys: [key], expectedRevision: 1, expectedFingerprint: fingerprint });
  conflict = true; const beforeConflict = calls.length;
  assert.equal((await invoke('configure_game_text_source', setup)).data.code, 'SOURCE_CHANGED');
  assert.equal(calls.length, beforeConflict + 2, 'Do not scan or retry a conflicting save');
  conflict = false; scanFails = true;
  const failure = await invoke('configure_game_text_source', setup);
  assert.equal(failure.isError, true); assert.equal(failure.data.configurationSaved, true); assert.equal(failure.data.code, 'SCAN_FAILED');
  const beforeUpload = calls.length;
  const upload = await invoke('upload_game_text', { project_directory: directory, gameSlug: 'my-game', use: 'phrases', original: { locale: 'zh', path: 'original.json' }, translations: [{ locale: 'en', path: 'en.json' }] });
  assert.equal(upload.isError, false); assert.deepEqual(upload.data.uploaded, ['zh', 'en']);
  assert.ok(calls.slice(beforeUpload).every(call => call.path.endsWith('?use=phrases')));
  assert.deepEqual(Object.keys(files.keys), []);
  assert.equal((await invoke('get_game_text_status', { gameSlug: 'my-game', use: 'phrases' })).data.status.length, 2);
  assert.deepEqual((await invoke('get_game_text_status', { gameSlug: 'my-game' })).data.status, []);
  await writeFile(join(directory, 'bad.json'), JSON.stringify({ [key]: 'Changed original' }));
  const beforeBad = calls.length;
  const bad = await invoke('upload_game_text', { project_directory: directory, gameSlug: 'my-game', use: 'phrases', original: { locale: 'zh', path: 'bad.json' }, force: true });
  assert.equal(bad.isError, true); assert.equal(bad.data.code, 'INVALID_PHRASE_ORIGINAL'); assert.equal(calls.length, beforeBad);
  // A translation-only retry obtains and validates the phrases original, never the keys original.
  const beforeRetry = calls.length;
  const retry = await invoke('upload_game_text', { project_directory: directory, gameSlug: 'my-game', use: 'phrases', translations: [{ locale: 'en', path: 'en.json' }] });
  assert.equal(retry.isError, false); assert.ok(calls.slice(beforeRetry).every(call => call.path.endsWith('?use=phrases')));
  assert.equal(calls.slice(beforeRetry).filter(call => call.method === 'PUT').length, 1);
});
