import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Platform } from '../src/platform.js';
import { recordPublishJob } from '../src/publish-progress.js';

const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const gameId = '11111111-1111-4111-8111-111111111111';
const boardId = '22222222-2222-4222-8222-222222222222';
const otherBoard = '33333333-3333-4333-8333-333333333333';
const buildId = '44444444-4444-4444-8444-444444444444';
const playerOrigin = 'https://www.ai-made.games';
const release = { version: '1.0.0', title: 'First release', notes: 'Initial playable game', changeType: 'minor' };
const state = extra => ({ game: { id: gameId, slug: 'owned-game', title: 'Owned game', status: 'published' },
  platformOrigin: playerOrigin, cloudSaves: { enabled: false, schemaVersion: 1 }, leaderboards: [], ...extra });
const parsed = reply => JSON.parse(reply.content[0].text);

// Every tool runs in the real server over MCP stdio. Only the authenticated platform HTTP API is
// local and controlled: no production account, game, player data or AI provider is contacted.
async function fixture(t, handler, { connected = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), '1gp-workflow-'));
  const requests = [], clients = new Set(), errors = [];
  const http = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const entry = { method: request.method, url: request.url, authorization: request.headers.authorization, body: text ? JSON.parse(text) : undefined };
      requests.push(entry);
      const answer = await handler(entry);
      response.statusCode = answer.status ?? 200;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(answer.body));
    } catch (error) { errors.push(error); response.statusCode = 500; response.end(JSON.stringify({ code: 'MOCK_FAILURE', error: error.message })); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const platform = new Platform({ origin, configDirectory: join(home, '.config', '1gp-studio') });
  const credentials = async token => {
    await mkdir(platform.directory, { recursive: true });
    if (token) await writeFile(platform.file, JSON.stringify({ token }), { mode: 0o600 });
    else await rm(platform.file, { force: true });
  };
  if (connected) await credentials(tokenA);
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise(resolve => http.close(resolve));
    await rm(home, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'The mock API must not hide request-contract failures');
  });
  const connect = async () => {
    const client = new Client({ name: '1gp-workflow-test', version: '1.0.0' }); clients.add(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
      env: { ...process.env, ONEGP_PLATFORM_URL: origin, HOME: home, USERPROFILE: home }, stderr: 'pipe' }));
    return client;
  };
  const disconnect = async client => { await client.close(); clients.delete(client); };
  return { home, platform, requests, credentials, connect, disconnect, client: await connect() };
}

test('new workflow tools and opt-in prompts are discoverable through the actual MCP connection', async t => {
  const f = await fixture(t, () => { throw new Error('Discovery must not call the platform'); });
  const tools = (await f.client.listTools()).tools;
  for (const name of ['prepare_game', 'get_game_integrations', 'configure_cloud_saves', 'configure_leaderboard', 'wait_for_publish']) assert.ok(tools.some(tool => tool.name === name), name);
  const cloud = tools.find(tool => tool.name === 'configure_cloud_saves');
  assert.deepEqual([...cloud.inputSchema.required].sort(), ['enabled', 'gameSlug', 'schemaVersion']);
  const wait = tools.find(tool => tool.name === 'wait_for_publish');
  assert.equal(wait.inputSchema.properties.wait_seconds.maximum, 45);
  assert.equal(wait.inputSchema.required?.includes('build_id') ?? false, false);
  for (const name of ['add_cloud_saves', 'add_leaderboard']) {
    assert.ok((await f.client.listPrompts()).prompts.some(prompt => prompt.name === name));
    const prompt = await f.client.getPrompt({ name });
    assert.equal(prompt.messages[0].role, 'user');
    assert.match(prompt.messages[0].content.text, /prepare_game/);
    assert.match(prompt.messages[0].content.text, /platformOrigin/);
    assert.match(prompt.messages[0].content.text, /wait_for_publish/);
    assert.match(prompt.messages[0].content.text, name === 'add_cloud_saves' ? /configure_cloud_saves/ : /configure_leaderboard/);
  }
  assert.equal(f.requests.length, 0);
});

test('invalid configuration is rejected before any HTTP request, including immutable board changes', async t => {
  const f = await fixture(t, () => { throw new Error('Invalid tool input reached the platform'); });
  const board = { key: 'best-score', name: 'Best score', order: 'desc', unit: 'points' };
  const cases = [
    ['prepare_game', { project_directory: f.home, features: { cloudSaves: 'yes' } }],
    ['prepare_game', { project_directory: f.home, features: { unknown: true } }],
    ['get_game_integrations', { gameSlug: '../other' }],
    ['get_game_integrations', { gameSlug: 'owned-game', feature: 'players' }],
    ['get_game_integrations', { gameSlug: 'owned-game', feature: 'leaderboards' }],
    ['configure_cloud_saves', { gameSlug: 'owned-game', schemaVersion: 1 }],
    ['configure_cloud_saves', { gameSlug: 'owned-game', enabled: true, schemaVersion: 0 }],
    ['configure_cloud_saves', { gameSlug: 'owned-game', enabled: true, schemaVersion: 1.5 }],
    ['configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'create', board: { ...board, key: undefined } } }],
    ['configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'create', board: { ...board, minScore: 10, maxScore: 9 } } }],
    ['configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'create', board: { ...board, unit: 'seconds' } } }],
    ['configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'update', board: { id: boardId, name: 'Renamed', enabled: true, order: 'asc' } } }],
    ['wait_for_publish', { wait_seconds: 46 }], ['wait_for_publish', { build_id: 'not-a-build' }],
  ];
  for (const [name, args] of cases) assert.equal((await f.client.callTool({ name, arguments: args })).isError, true, `${name}: ${JSON.stringify(args)}`);
  assert.equal(f.requests.length, 0);
});

test('integration tools preserve the player origin and send the exact scoped GET, PUT and POST contracts', async t => {
  const f = await fixture(t, request => ({ body: state({ updated: request.method !== 'GET', integration: { prompt: 'Use the real game and board IDs', docsUrl: `${playerOrigin}/leaderboard-api.md` } }) }));
  const invoke = async (name, args) => {
    const reply = await f.client.callTool({ name, arguments: args }); assert.equal(reply.isError, false);
    const data = parsed(reply); assert.equal(data.platformOrigin, playerOrigin); assert.equal(JSON.stringify(data).includes(tokenA), false); return data;
  };
  await invoke('get_game_integrations', { gameSlug: 'owned-game' });
  await invoke('get_game_integrations', { gameSlug: 'owned-game', feature: 'cloud-saves' });
  await invoke('get_game_integrations', { gameSlug: 'owned-game', feature: 'leaderboards', boardId });
  await invoke('configure_cloud_saves', { gameSlug: 'owned-game', enabled: true, schemaVersion: 3 });
  await invoke('configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'create', board: { key: 'best-score', name: 'Best score', order: 'desc', unit: 'points' } } });
  await invoke('configure_leaderboard', { gameSlug: 'owned-game', configuration: { action: 'update', board: { id: boardId, name: 'New name', description: 'Only rename', enabled: false } } });
  assert.deepEqual(f.requests.map(({ method, url, body }) => ({ method, url, body })), [
    { method: 'GET', url: '/api/developer/game-integrations/owned-game', body: undefined },
    { method: 'GET', url: '/api/developer/game-integrations/owned-game?feature=cloud-saves', body: undefined },
    { method: 'GET', url: `/api/developer/game-integrations/owned-game?feature=leaderboards&boardId=${boardId}`, body: undefined },
    { method: 'PUT', url: '/api/developer/game-integrations/owned-game', body: { feature: 'cloud-saves', enabled: true, schemaVersion: 3 } },
    { method: 'POST', url: '/api/developer/game-integrations/owned-game', body: { feature: 'leaderboards', action: 'create', board: { key: 'best-score', name: 'Best score', description: '', order: 'desc', unit: 'points', minScore: 0, maxScore: 1000000000, minPlayMs: 0 } } },
    { method: 'POST', url: '/api/developer/game-integrations/owned-game', body: { feature: 'leaderboards', action: 'update', board: { id: boardId, name: 'New name', description: 'Only rename', enabled: false } } },
  ]);
  assert.ok(f.requests.every(request => request.authorization === `Bearer ${tokenA}`));
});

test('missing authorization and cross-game configuration failures remain errors without fallback writes', async t => {
  let answer = { status: 403, body: { code: 'FORBIDDEN', error: 'Not the author' } };
  const f = await fixture(t, () => answer, { connected: false });
  const cloud = { gameSlug: 'foreign-game', enabled: true, schemaVersion: 1 };
  const missing = await f.client.callTool({ name: 'configure_cloud_saves', arguments: cloud });
  assert.equal(missing.isError, true); assert.equal(parsed(missing).code, 'AUTH_REQUIRED'); assert.equal(f.requests.length, 0);
  await f.credentials(tokenA);
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'GAME_NOT_FOUND'], [409, 'SCHEMA_DOWNGRADE'], [503, 'SERVICE_UNAVAILABLE']]) {
    answer = { status, body: { code, error: `Denied: ${code}` } };
    const reply = await f.client.callTool({ name: 'configure_cloud_saves', arguments: cloud });
    assert.equal(reply.isError, true); assert.deepEqual(parsed(reply), answer.body);
  }
  answer = { status: 404, body: { code: 'BOARD_NOT_FOUND', error: 'Board belongs to another game' } };
  const other = await f.client.callTool({ name: 'configure_leaderboard', arguments: { gameSlug: 'owned-game', configuration: { action: 'update', board: { id: otherBoard, name: 'Keep scores', enabled: true } } } });
  assert.equal(other.isError, true); assert.equal(parsed(other).code, 'BOARD_NOT_FOUND');
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests.at(-1).body.action, 'update', 'A foreign board must never be replaced with a newly created board');
});

test('prepare_game aggregates preparation once, remembers only explicit choices, and does not enable features or run scripts', async t => {
  const f = await fixture(t, request => {
    const path = new URL(request.url, 'http://test').pathname;
    if (path === '/api/developer/games/match') return { body: { matches: [{ slug: 'owned-game', title: 'Owned game' }] } };
    if (path === '/api/publish/releases/context') return { body: { gameSlug: 'owned-game', source: 'local', previous: null } };
    assert.equal(path, '/api/developer/game-integrations/owned-game'); assert.equal(request.method, 'GET');
    return { body: state() };
  });
  const game = join(f.home, 'game'); await mkdir(join(game, 'dist'), { recursive: true });
  await writeFile(join(game, 'dist', 'index.html'), '<canvas>Game</canvas>');
  await writeFile(join(game, 'package.json'), JSON.stringify({ name: 'workflow-game', scripts: { build: 'node build.cjs' } }));
  await writeFile(join(game, 'build.cjs'), "require('node:fs').writeFileSync('ran-build','yes')");
  const args = { project_directory: game, output_directory: 'dist' };
  const initial = await f.client.callTool({ name: 'prepare_game', arguments: args }); assert.equal(initial.isError, false);
  const data = parsed(initial);
  assert.equal(data.gameSlug, 'owned-game'); assert.equal(data.channel, 'local'); assert.equal(data.inspection.ready, true);
  assert.equal(data.languageCheck.multilingual, false); assert.equal(data.integrations.cloudSaves.enabled, false);
  assert.deepEqual(data.features, { multilingual: null, cloudSaves: null, leaderboards: null });
  assert.deepEqual(data.decisions, ['multilingual', 'cloudSaves', 'leaderboards']);
  assert.equal(f.requests.length, 3, 'One game match, one release context and one integrations read');
  const selected = parsed(await f.client.callTool({ name: 'prepare_game', arguments: { ...args, features: { cloudSaves: true, leaderboards: false } } }));
  assert.deepEqual(selected.features, { multilingual: null, cloudSaves: true, leaderboards: false });
  assert.equal(selected.integrations.cloudSaves.enabled, false, 'Remembered intention must not be reported as an enabled service');
  await f.disconnect(f.client); const resumed = await f.connect();
  assert.deepEqual(parsed(await resumed.callTool({ name: 'prepare_game', arguments: args })).features, selected.features);
  await f.credentials(tokenB);
  assert.deepEqual(parsed(await resumed.callTool({ name: 'prepare_game', arguments: args })).features, data.features, 'A different account has no inherited consent');
  assert.equal(f.requests.length, 12);
  assert.ok(f.requests.every(request => request.method === 'GET' || request.url === '/api/developer/games/match'));
  await assert.rejects(stat(join(game, 'ran-build')), { code: 'ENOENT' });
  assert.equal(await readFile(join(game, 'dist', 'index.html'), 'utf8'), '<canvas>Game</canvas>');
});

test('prepare_game stops on ownership mismatch or ambiguous matches instead of guessing another game', async t => {
  let answer = { status: 404, body: { code: 'GAME_MISMATCH', error: 'This is another project' } };
  const f = await fixture(t, request => { assert.equal(request.url, '/api/developer/games/match'); return answer; });
  const game = join(f.home, 'game'); await mkdir(game); await writeFile(join(game, 'index.html'), 'Game');
  const denied = await f.client.callTool({ name: 'prepare_game', arguments: { project_directory: game, gameSlug: 'other-game' } });
  assert.equal(denied.isError, true); assert.equal(parsed(denied).code, 'GAME_MISMATCH');
  answer = { body: { matches: [{ slug: 'one', title: 'One' }, { slug: 'two', title: 'Two' }] } };
  const ambiguous = parsed(await f.client.callTool({ name: 'prepare_game', arguments: { project_directory: game } }));
  assert.equal(ambiguous.code, 'CHOOSE_GAME'); assert.equal(ambiguous.gameSlug, undefined);
  assert.equal(f.requests.length, 2);
});

test('wait_for_publish resumes a persisted job through stdio and keeps account changes isolated', async t => {
  const f = await fixture(t, request => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, `/api/publish/${buildId}`);
    return { body: { id: buildId, state: 'ready', games: { slug: 'owned-game' } } };
  });
  assert.equal((await recordPublishJob(f.platform, { buildId, channel: 'local' })).recorded, true);
  const ready = await f.client.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } });
  assert.equal(ready.isError, false);
  assert.equal(parsed(ready).gameUrl, `${f.platform.origin}/games/owned-game`); assert.equal(parsed(ready).resumed, true);
  assert.equal(parsed(ready).terminal, true); assert.equal(parsed(ready).pending, false);
  await f.credentials(tokenB);
  const missing = await f.client.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } });
  assert.equal(missing.isError, true); assert.equal(parsed(missing).code, 'NO_PUBLISH_JOB');
  assert.equal(f.requests.length, 1);
});

test('publishing records the returned build and a restarted MCP process waits for it without publishing again', async t => {
  let statusReads = 0;
  const f = await fixture(t, request => {
    if (request.method === 'POST') { assert.equal(request.url, '/api/publish'); return { body: { id: buildId, state: 'queued', path: '/games/owned-game' } }; }
    assert.equal(request.method, 'GET'); assert.equal(request.url, `/api/publish/${buildId}`);
    return { body: { id: buildId, state: ++statusReads === 1 ? 'building' : 'ready', games: { slug: 'owned-game' } } };
  });
  const game = join(f.home, 'game'); await mkdir(game); await writeFile(join(game, 'index.html'), '<canvas>Game</canvas>');
  const submitted = await f.client.callTool({ name: 'publish_game', arguments: { project_directory: game, title: 'Owned game', release } });
  assert.equal(submitted.isError, false); assert.equal(parsed(submitted).tracking.recorded, true);
  assert.equal(parsed(submitted).state, 'queued', 'A preassigned game page is not deployment completion');
  const pending = parsed(await f.client.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } }));
  assert.equal(pending.pending, true); assert.equal(pending.terminal, false); assert.equal(pending.gameUrl, undefined);
  await f.disconnect(f.client); const restarted = await f.connect();
  const ready = parsed(await restarted.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } }));
  assert.equal(ready.state, 'ready'); assert.equal(ready.resumed, true); assert.equal(ready.buildId, buildId);
  assert.equal(ready.gameUrl, `${f.platform.origin}/games/owned-game`);
  assert.deepEqual(f.requests.map(request => request.method), ['POST', 'GET', 'GET']);
  assert.equal(f.requests[0].body.source, 'local');
  const { sourceFiles, ...metadata } = f.requests[0].body.release;
  assert.deepEqual(metadata, release); assert.deepEqual(Object.keys(sourceFiles), ['index.html']);
  assert.match(sourceFiles['index.html'], /^[a-f0-9]{64}$/);
});
