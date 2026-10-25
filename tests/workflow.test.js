import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Platform } from '../src/platform.js';
import { recordPublishJob } from '../src/publish-progress.js';
import { prepareGameUpdate } from '../src/game-updates.js';
import { updateApprovalGuidance, updateHistoryGuidance } from '../src/update-approval-guidance.js';

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
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), json = request.headers['content-type']?.startsWith('application/json');
      const entry = { method: request.method, url: request.url, authorization: request.headers.authorization,
        body: bytes.length && json ? JSON.parse(bytes.toString('utf8')) : undefined,
        ...(!json && bytes.length ? { bytes, type: request.headers['content-type'], idempotencyKey: request.headers['idempotency-key'] } : {}) };
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
  for (const name of ['prepare_game', 'get_game_integrations', 'configure_cloud_saves', 'configure_leaderboard', 'wait_for_publish', 'get_publisher_info', 'get_game_materials', 'get_game_announcement', 'publish_game_announcement', 'complete_game_update', 'get_game_updates', 'delete_game_update', 'set_game_media']) assert.ok(tools.some(tool => tool.name === name), name);
  for (const name of ['complete_game_update', 'delete_game_update']) assert.ok(tools.find(tool => tool.name === name).inputSchema.required.includes('approved'), `${name} requires author approval`);
  const cloud = tools.find(tool => tool.name === 'configure_cloud_saves');
  assert.deepEqual([...cloud.inputSchema.required].sort(), ['enabled', 'gameSlug', 'schemaVersion']);
  const wait = tools.find(tool => tool.name === 'wait_for_publish');
  assert.equal(wait.inputSchema.properties.wait_seconds.maximum, 45);
  assert.equal(wait.inputSchema.required?.includes('build_id') ?? false, false);
  for (const name of ['publish_game', 'publish_link', 'publish_docker_game', 'update_github_game']) {
    const publish = tools.find(tool => tool.name === name);
    assert.ok(publish.inputSchema.properties.release.required.includes('updateId'), `${name} must forward the prepared group`);
    assert.ok(publish.inputSchema.required.includes('project_directory'), `${name} keeps project/account isolation`);
  }
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
    assert.equal(reply.isError, true);
    if (status === 401) { assert.equal(parsed(reply).code, 'AUTH_REQUIRED'); assert.equal(parsed(reply).status, 401); }
    else assert.deepEqual(parsed(reply), { ...answer.body, status });
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
    if (path === '/api/developer/game-materials/owned-game') return { body: { game: { id: gameId, slug: 'owned-game' }, original: { locale: 'zh' }, languages: [], covers: {} } };
    if (path === '/api/developer/text-source/owned-game') return { body: { config: null, engine: null, status: [], integration: { state: 'not_verified', message: 'Renderer integration needs verification' } } };
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
  assert.ok(data.instructions.includes(updateApprovalGuidance.en));
  assert.ok(data.instructions.includes(updateHistoryGuidance.en));
  assert.ok(!data.instructions.includes(updateApprovalGuidance.zh), 'the approval rules appear once');
  assert.equal(data.gameSlug, 'owned-game'); assert.equal(data.channel, 'local'); assert.equal(data.inspection.ready, true);
  assert.equal(data.materials.error, undefined); assert.equal(data.materials.original.locale, 'zh');
  assert.equal(data.languageCheck.multilingual, false); assert.equal(data.integrations.cloudSaves.enabled, false);
  assert.deepEqual(data.features, { multilingual: null, cloudSaves: null, leaderboards: null, announcement: null });
  assert.deepEqual(data.decisions, []); assert.deepEqual(data.optionalFeatures, ['multilingual', 'cloudSaves', 'leaderboards']);
  assert.equal(f.requests.length, 6, 'One game match, release context, integrations, materials and each text source mode read');
  assert.deepEqual(f.requests.filter(request => request.url.includes('/text-source/')).map(request => request.url).sort(), ['/api/developer/text-source/owned-game?use=keys', '/api/developer/text-source/owned-game?use=phrases']);
  assert.deepEqual(Object.keys(data.textSources).sort(), ['keys', 'phrases']);
  const selected = parsed(await f.client.callTool({ name: 'prepare_game', arguments: { ...args, features: { cloudSaves: true, leaderboards: false } } }));
  assert.deepEqual(selected.features, { multilingual: null, cloudSaves: true, leaderboards: false, announcement: null });
  assert.equal(selected.integrations.cloudSaves.enabled, false, 'Remembered intention must not be reported as an enabled service');
  await f.disconnect(f.client); const resumed = await f.connect();
  assert.deepEqual(parsed(await resumed.callTool({ name: 'prepare_game', arguments: args })).features, selected.features);
  await f.credentials(tokenB);
  assert.deepEqual(parsed(await resumed.callTool({ name: 'prepare_game', arguments: args })).features, data.features, 'A different account has no inherited consent');
  assert.equal(f.requests.length, 24);
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
  assert.equal(parsed(ready).workflowComplete, false); assert.equal(parsed(ready).materialStatus, 'needs_verification');
  assert.match(parsed(ready).nextSteps.join('\n'), /set_game_media/);
  await f.credentials(tokenB);
  const missing = await f.client.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } });
  assert.equal(missing.isError, true); assert.equal(parsed(missing).code, 'NO_PUBLISH_JOB');
  assert.equal(f.requests.length, 1);
});

test('publishing records the returned build and a restarted MCP process waits for it without publishing again', async t => {
  let statusReads = 0;
  const f = await fixture(t, request => {
    if (request.url === '/api/developer/game-updates') return { body: { created: true, update: { id: request.body.updateId, gameSlug: null, state: 'open' } } };
    if (request.url.startsWith('/api/publish/releases/context?')) return { body: { previous: null } };
    if (request.method === 'POST') { assert.equal(request.url, '/api/publish'); return { body: { id: buildId, state: 'queued', path: '/games/owned-game' } }; }
    assert.equal(request.method, 'GET'); assert.equal(request.url, `/api/publish/${buildId}`);
    return { body: { id: buildId, state: ++statusReads === 1 ? 'building' : 'ready', games: { slug: 'owned-game' } } };
  });
  const game = join(f.home, 'game'); await mkdir(game); await writeFile(join(game, 'index.html'), '<canvas>Game</canvas>');
  const update = await prepareGameUpdate(f.platform, game);
  const groupedRelease = { ...release, updateId: update.id };
  const submitted = await f.client.callTool({ name: 'publish_game', arguments: { project_directory: game, title: 'Owned game', release: groupedRelease } });
  assert.equal(submitted.isError, false); assert.equal(parsed(submitted).tracking.recorded, true);
  assert.equal(parsed(submitted).state, 'queued', 'A preassigned game page is not deployment completion');
  const pending = parsed(await f.client.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } }));
  assert.equal(pending.pending, true); assert.equal(pending.terminal, false); assert.equal(pending.gameUrl, undefined);
  await f.disconnect(f.client); const restarted = await f.connect();
  const ready = parsed(await restarted.callTool({ name: 'wait_for_publish', arguments: { wait_seconds: 0 } }));
  assert.equal(ready.state, 'ready'); assert.equal(ready.resumed, true); assert.equal(ready.buildId, buildId);
  assert.equal(ready.gameUrl, `${f.platform.origin}/games/owned-game`);
  assert.deepEqual(f.requests.map(request => request.method), ['POST', 'GET', 'POST', 'GET', 'GET']);
  assert.equal(f.requests[2].body.source, 'local');
  const { sourceFiles, ...metadata } = f.requests[2].body.release;
  assert.deepEqual(metadata, groupedRelease); assert.deepEqual(Object.keys(sourceFiles), ['index.html']);
  assert.match(sourceFiles['index.html'], /^[a-f0-9]{64}$/);
});

test('link and Docker deployments carry their prepared update group and complete exactly that task through stdio', async t => {
  for (const channel of ['external', 'docker']) await t.test(channel, async t => {
    let updateId, completed = false;
    const f = await fixture(t, request => {
      if (request.url === '/api/developer/game-updates') {
        assert.equal(request.body.updateId, updateId);
        return { body: { created: true, update: { id: updateId, gameSlug: 'owned-game', state: 'open' } } };
      }
      if (request.url === `/api/publish/docker/uploads/${otherBoard}`) return { body: { state: 'ready', project: 'owned-game' } };
      if (request.url === '/api/publish') {
        assert.equal(request.body.source, channel); assert.equal(request.body.release.updateId, updateId);
        return { body: { id: buildId, state: 'ready', path: '/games/owned-game' } };
      }
      assert.equal(request.url, `/api/developer/game-updates/${updateId}/complete`);
      assert.deepEqual(request.body, { title: 'Combined release', notes: 'All selected features verified.', approved: true });
      const created = !completed; completed = true;
      return { body: { updateId, gameSlug: 'owned-game', status: 'published', created, version: '1.0.0', post: { id: boardId, url: `https://www.ai-made.games/community/p/${boardId}` } } };
    });
    const game = join(f.home, 'game'); await mkdir(game); await writeFile(join(game, 'index.html'), '<canvas>Game</canvas>');
    updateId = (await prepareGameUpdate(f.platform, game, { gameSlug: 'owned-game' })).id;
    const args = { project_directory: game, title: 'Owned game', release: { ...release, updateId }, ...(channel === 'external' ? { url: 'https://play.example/game' } : { project: 'owned-game', upload_id: otherBoard }) };
    const response = await f.client.callTool({ name: channel === 'external' ? 'publish_link' : 'publish_docker_game', arguments: args });
    assert.equal(response.isError, false); assert.equal(parsed(response).updateId, updateId);
    const content = { project_directory: game, update_id: updateId, title: 'Combined release', notes: 'All selected features verified.' };
    const before = f.requests.length;
    for (const extra of [{}, { approved: false }, { approved: 'true' }]) assert.equal((await f.client.callTool({ name: 'complete_game_update', arguments: { ...content, ...extra } })).isError, true);
    assert.equal(f.requests.length, before, 'No completion HTTP request without explicit author approval');
    const finish = { ...content, approved: true };
    assert.equal(parsed(await f.client.callTool({ name: 'complete_game_update', arguments: finish })).created, true);
    assert.equal(parsed(await f.client.callTool({ name: 'complete_game_update', arguments: finish })).created, false);
    assert.equal(f.requests.filter(request => request.url === '/api/publish').length, 1, 'Completion retries cannot deploy another version');
    assert.notEqual((await prepareGameUpdate(f.platform, game, { gameSlug: 'owned-game' })).id, updateId);
  });
});

test('author update listing and deletion tools use exact selected references through stdio', async t => {
  const reference = `build:${buildId}`, date = '2026-10-22T12:30:00.000Z';
  const cursor = Buffer.from(JSON.stringify({ at: date, reference })).toString('base64url');
  const record = { reference, version: '1.0.0', title: 'Duplicate update', notes: 'Verified fixes.', createdAt: date };
  let removed = false;
  const f = await fixture(t, request => {
    if (request.method === 'GET') {
      assert.ok(request.url === '/api/developer/game-updates?gameSlug=owned-game' || request.url === `/api/developer/game-updates?gameSlug=owned-game&cursor=${cursor}`);
      return { body: { gameSlug: 'owned-game', updates: removed ? [] : [record], nextCursor: request.url.includes('cursor=') ? null : cursor } };
    }
    assert.equal(request.url, '/api/developer/game-updates'); assert.equal(request.method, 'DELETE');
    assert.deepEqual(request.body, { gameSlug: 'owned-game', reference, approved: true });
    const alreadyDeleted = removed; removed = true;
    return { body: { gameSlug: 'owned-game', reference, deleted: true, alreadyDeleted } };
  });
  const first = parsed(await f.client.callTool({ name: 'get_game_updates', arguments: { gameSlug: 'owned-game' } }));
  assert.deepEqual(first.updates, [record]); assert.equal(first.nextCursor, cursor);
  const next = parsed(await f.client.callTool({ name: 'get_game_updates', arguments: { gameSlug: 'owned-game', cursor: first.nextCursor } }));
  assert.equal(next.nextCursor, null);
  const before = f.requests.length;
  for (const extra of [{}, { approved: false }, { approved: 'true' }]) assert.equal((await f.client.callTool({ name: 'delete_game_update', arguments: { gameSlug: 'owned-game', reference, ...extra } })).isError, true);
  assert.equal(f.requests.length, before, 'Missing or false approval cannot remove anything');
  const args = { gameSlug: 'owned-game', reference, approved: true };
  assert.equal(parsed(await f.client.callTool({ name: 'delete_game_update', arguments: args })).alreadyDeleted, false);
  assert.equal(parsed(await f.client.callTool({ name: 'delete_game_update', arguments: args })).alreadyDeleted, true);
  assert.ok(f.requests.every(request => request.authorization === `Bearer ${tokenA}`));
  assert.equal(f.requests.some(request => request.url === '/api/publish'), false, 'Record removal cannot redeploy or roll back a game');
});

test('runtime version and materials/announcement contracts are exposed through the running MCP', async t => {
  const f = await fixture(t, request => ({ body: request.url.includes('game-announcement') ?
    { game: { id: gameId, slug: 'owned-game', url: playerOrigin + '/games/owned-game' }, ready: true, eligible: true, launchReference: 'build:' + buildId, announcement: { status: 'missing' }, draft: { title: 'Launch', body: 'Play the game' }, id: boardId, url: playerOrigin + '/community/p/' + boardId, created: true, status: 'published' } :
    { game: { id: gameId, slug: 'owned-game' }, original: { locale: 'zh' }, languages: [], covers: {}, ok: true, filled: { titles: ['ja'], descriptions: [] }, skipped: {} } }));
  const info = parsed(await f.client.callTool({ name: 'get_publisher_info', arguments: {} }));
  assert.equal(info.version, f.client.getServerVersion().version);
  assert.ok(info.capabilities.includes('title-overlay-covers')); assert.equal(info.upgrade.automatic, false);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.client.callTool({ name: 'get_game_materials', arguments: { gameSlug: 'owned-game' } })).isError, false);
  const filled = await f.client.callTool({ name: 'set_game_details', arguments: { gameSlug: 'owned-game', titles: { ja: 'ゲーム' }, fillMissing: true } });
  assert.equal(filled.isError, false);
  assert.deepEqual(f.requests.at(-1).body, { titles: { ja: 'ゲーム' }, fillMissing: true });
  assert.equal(f.requests.at(-1).method, 'PATCH');
  await f.client.callTool({ name: 'get_game_announcement', arguments: { gameSlug: 'owned-game' } });
  const content = { gameSlug: 'owned-game', title: 'Launch', body: 'Play the game', launchReference: 'build:' + buildId };
  const before = f.requests.length;
  for (const extra of [{}, { approved: false }]) assert.equal((await f.client.callTool({ name: 'publish_game_announcement', arguments: { ...content, ...extra } })).isError, true);
  assert.equal(f.requests.length, before, 'No HTTP post without explicit content approval');
  const posted = await f.client.callTool({ name: 'publish_game_announcement', arguments: { ...content, approved: true } });
  assert.equal(posted.isError, false);
  assert.equal(f.requests.at(-1).method, 'POST');
  assert.equal(f.requests.at(-1).url, '/api/developer/game-announcement/owned-game');
});

test('cover tool accepts partial language choices through stdio and retains incomplete-material reports', async t => {
  const report = { ok: true, filled: [], skipped: [{ locale: 'ja', reason: 'BASE_REQUIRED' }], partial: true };
  const f = await fixture(t, request => {
    assert.equal(request.url, '/api/games/owned-game/covers');
    assert.equal(request.method, 'PUT');
    return { body: report };
  });
  for (const modes of [{ ja: 'gen' }, { en: 'gen', ja: 'gen', ko: 'gen', es: 'gen' }]) {
    const result = await f.client.callTool({ name: 'set_game_covers', arguments: { project_directory: f.home, gameSlug: 'owned-game', modes, fillMissing: true } });
    assert.equal(result.isError, false); assert.equal(parsed(result).partial, true);
    assert.deepEqual(parsed(result).skipped, report.skipped);
    assert.deepEqual(f.requests.at(-1).body, { modes, titles: {}, fillMissing: true });
  }
  const schema = (await f.client.listTools()).tools.find(tool => tool.name === 'set_game_covers').inputSchema;
  assert.equal(schema.properties.special.required?.length ?? 0, 0, 'A single special cover must not require files in every locale');
});

test('store labels only fill missing metadata and actual media bytes travel through the authenticated stdio tool', async t => {
  const receipts = new Set();
  const f = await fixture(t, async request => {
    if (request.url === '/api/developer/game-materials/owned-game') {
      assert.equal(request.method, 'PATCH');
      assert.deepEqual(request.body, { genre: 'action', tags: ['肉鸽', '像素'], fillMissing: true });
      return { body: { ok: true, partial: false, filled: { titles: [], descriptions: [], genre: true, tags: true }, skipped: { titles: [], descriptions: [], genre: null, tags: null } } };
    }
    assert.ok(['/api/games/owned-game/cover?fillMissing=true', '/api/games/owned-game/screenshots'].includes(request.url));
    assert.equal(request.authorization, `Bearer ${tokenA}`); assert.equal(request.type, 'image/webp');
    assert.equal(request.idempotencyKey, createHash('sha256').update(request.bytes).digest('hex'));
    const metadata = await sharp(request.bytes).metadata(); assert.equal(metadata.format, 'webp');
    const screenshot = request.url.endsWith('/screenshots'), key = request.url + request.idempotencyKey, created = !receipts.has(key);
    receipts.add(key);
    return { body: { ok: true, created, skipped: false, src: `/api/${screenshot ? 'game-shots' : 'game-covers'}/${gameId}/${boardId}.webp`, ...(screenshot ? { id: boardId, width: metadata.width, height: metadata.height } : {}) } };
  });
  const details = { gameSlug: 'owned-game', genre: 'action', tags: ['肉鸽', '像素'] };
  for (const options of [{}, { fillMissing: false }, { fillMissing: true, languages: ['zh'] }]) {
    assert.equal((await f.client.callTool({ name: 'set_game_details', arguments: { ...details, ...options } })).isError, true);
  }
  assert.equal(f.requests.length, 0, 'Classification never falls back to the old overwriting endpoint');
  const filled = await f.client.callTool({ name: 'set_game_details', arguments: { ...details, fillMissing: true } });
  assert.equal(filled.isError, false); assert.equal(parsed(filled).filled.genre, true);
  const game = join(f.home, 'game'); await mkdir(game);
  await writeFile(join(game, 'cover.png'), await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).png().toBuffer());
  await writeFile(join(game, 'shot.png'), await sharp({ create: { width: 32, height: 24, channels: 3, background: 'blue' } }).png().toBuffer());
  const args = { project_directory: game, gameSlug: 'owned-game', cover: 'cover.png', screenshots: ['shot.png'], fillMissing: true };
  const uploaded = await f.client.callTool({ name: 'set_game_media', arguments: args });
  assert.equal(uploaded.isError, false); assert.equal(parsed(uploaded).uploaded.length, 2);
  const retried = await f.client.callTool({ name: 'set_game_media', arguments: args });
  assert.equal(retried.isError, false); assert.ok(parsed(retried).uploaded.every(item => item.created === false));
  assert.equal(receipts.size, 2, 'Retries use stable media fingerprints');
  assert.ok(f.requests.every(request => !request.url.startsWith('/api/publish')), 'Media changes never deploy a new game version');
});
