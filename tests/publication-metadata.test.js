import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Platform } from '../src/platform.js';
import { prepareGameUpdate } from '../src/game-updates.js';

const owned = { gameSlug: 'owned-game', source: 'local', previous: null };
const parsed = reply => JSON.parse(reply.content[0].text);
async function fixture(t, initialContext = owned) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'publication-metadata-'))), game = join(home, 'game');
  await mkdir(game);
  await writeFile(join(game, 'index.html'), '<title>Project title</title><p>Game</p>');
  await mkdir(join(game, 'site')); await writeFile(join(game, 'site/index.html'), '<title>Project title</title><p>Game</p>');
  await writeFile(join(game, 'package.json'), JSON.stringify({ name: 'project-name', description: 'Project description' }));
  let context = initialContext, original = { title: 'Author title', description: 'Author description' }, materialsError;
  const requests = [], errors = [];
  const http = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const url = new URL(req.url, 'http://test'); requests.push({ path: url.pathname, query: url.searchParams, input });
      let response;
      if (url.pathname === '/api/developer/game-updates') response = { created: true, update: { id: input.updateId, gameSlug: input.gameSlug ?? null, state: 'open' } };
      else if (url.pathname === '/api/publish/releases/context') response = context;
      else if (url.pathname === '/api/developer/game-materials/owned-game') response = materialsError ?? { game: { slug: 'owned-game' }, original, languages: [], covers: {} };
      else if (url.pathname === '/api/publish') response = { id: '11111111-1111-4111-8111-111111111111', state: 'queued', path: '/games/' + (input.gameSlug ?? 'new-game') };
      else throw new Error('Unexpected request: ' + req.url);
      res.statusCode = response?.error ? 503 : 200;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
    } catch (error) { errors.push(error); res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`, platform = new Platform({ origin, configDirectory: join(home, '.config/1gp-studio') });
  await mkdir(platform.directory, { recursive: true }); await writeFile(platform.file, JSON.stringify({ token: 'a'.repeat(64) }), { mode: 0o600 });
  const update = await prepareGameUpdate(platform, game); assert.ok(update.id, JSON.stringify(update));
  const release = { updateId: update.id, version: '1.0.1', title: 'Checked patch', notes: 'Checked source', changeType: 'patch' };
  const client = new Client({ name: 'metadata-regression', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))], env: { ...process.env, ONEGP_PLATFORM_URL: origin, HOME: home, USERPROFILE: home }, stderr: 'pipe' }));
  t.after(async () => { await client.close(); await new Promise(resolve => http.close(resolve)); await rm(home, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { requests, publish: input => client.callTool({ name: 'publish_game', arguments: { project_directory: game, output_directory: 'site', release, ...input } }),
    posts: () => requests.filter(item => item.path === '/api/publish').map(item => item.input),
    context: value => { context = value; }, original: value => { original = value; }, failure: value => { materialsError = value; } };
}

test('real MCP publication preserves platform metadata and applies only explicit field changes', async t => {
  const f = await fixture(t);
  for (const input of [{}, { title: 'Requested title' }, { description: 'Requested description' }, { description: '' }]) {
    const reply = await f.publish({ gameSlug: 'owned-game', ...input }); assert.equal(reply.isError, false, JSON.stringify(reply));
    const sent = f.posts().at(-1);
    assert.equal(sent.title, input.title ?? 'Author title'); assert.equal(sent.description, input.description ?? 'Author description');
    assert.equal(sent.gameSlug, 'owned-game');
  }
  f.original({ title: 'Author empty description', description: '' });
  assert.equal((await f.publish({ gameSlug: 'owned-game' })).isError, false);
  assert.equal(f.posts().at(-1).description, '', 'empty author content must not fall back to package metadata');
});

test('omitting gameSlug still preserves an existing local project while a confirmed new game uses project metadata', async t => {
  const existing = await fixture(t);
  assert.equal((await existing.publish({})).isError, false);
  assert.equal(existing.posts()[0].title, 'Author title'); assert.equal(existing.posts()[0].description, 'Author description');
  assert.equal(existing.posts()[0].gameSlug, 'owned-game');
  assert.match(existing.requests.find(item => item.path === '/api/publish/releases/context').query.get('projectId'), /^[a-f0-9]{32}$/);
  const fresh = await fixture(t, { previous: null });
  assert.equal((await fresh.publish({})).isError, false);
  assert.equal(fresh.posts()[0].title, 'Project title'); assert.equal(fresh.posts()[0].description, 'Project description');
  assert.equal(Object.hasOwn(fresh.posts()[0], 'gameSlug'), false);
});

test('unknown, missing, wrong-channel and unreadable existing metadata never fall back or submit a publication', async t => {
  const f = await fixture(t);
  for (const context of [{}, { previous: null }, { ...owned, gameSlug: 'wrong-game' }, { ...owned, source: 'github' }, { error: 'Unavailable', code: 'SERVICE_UNAVAILABLE' }]) {
    f.context(context); assert.equal((await f.publish({ gameSlug: 'owned-game' })).isError, true, JSON.stringify(context));
  }
  f.context(owned);
  for (const original of [{}, { title: 'Incomplete' }, { title: 'Author', description: 3 }]) {
    f.original(original); assert.equal((await f.publish({ gameSlug: 'owned-game' })).isError, true);
  }
  f.failure({ code: 'GAME_NOT_FOUND', error: 'No longer owned' });
  assert.equal(parsed(await f.publish({ gameSlug: 'owned-game', title: 'Explicit title', description: 'Explicit description' })).code, 'GAME_NOT_FOUND');
  assert.deepEqual(f.posts(), []);
});
