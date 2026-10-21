import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGameIntegrations, configureCloudSaves, configureLeaderboard } from '../src/integrations.js';

const boardId = '12345678-1234-4123-8123-123456789abc';
function platform(response = { game: { slug: 'test-game' }, platformOrigin: 'https://www.ai-made.games' }) {
  const calls = [];
  return { calls, response, request: async (path, options) => { calls.push({ path, options }); return response; } };
}

test('integration reads use only the author adapter and return its canonical player origin unchanged', async () => {
  const p = platform();
  assert.equal(await getGameIntegrations(p, 'test-game'), p.response);
  assert.equal(await getGameIntegrations(p, 'test-game', { feature: 'cloud-saves' }), p.response);
  assert.equal(await getGameIntegrations(p, 'test-game', { feature: 'leaderboards', boardId }), p.response);
  assert.deepEqual(p.calls, [
    { path: '/api/developer/game-integrations/test-game', options: undefined },
    { path: '/api/developer/game-integrations/test-game?feature=cloud-saves', options: undefined },
    { path: `/api/developer/game-integrations/test-game?feature=leaderboards&boardId=${boardId}`, options: undefined },
  ]);
  assert.equal(p.response.platformOrigin, 'https://www.ai-made.games');
});

test('invalid slugs cannot change the request path for any integration operation', async () => {
  const p = platform();
  for (const slug of ['', '../game', 'a/b', 'a?feature=cloud-saves', 'a%2fb', 'a#x', 'A', 'a'.repeat(201), null]) {
    await assert.rejects(getGameIntegrations(p, slug), /Invalid game slug/);
    await assert.rejects(configureCloudSaves(p, slug, { enabled: false, schemaVersion: 1 }), /Invalid game slug/);
    await assert.rejects(configureLeaderboard(p, slug, 'update', { id: boardId, name: 'Score', enabled: false }), /Invalid game slug/);
  }
  assert.deepEqual(p.calls, []);
});

test('an integration prompt requires an unambiguous feature and an actual leaderboard UUID', async () => {
  const p = platform();
  for (const options of [{ feature: 'scores' }, { feature: '' }, { boardId }, { feature: 'cloud-saves', boardId },
    { feature: 'leaderboards' }, { feature: 'leaderboards', boardId: '../scores' }, { feature: 'leaderboards', boardId: 'not-a-uuid' }]) {
    await assert.rejects(getGameIntegrations(p, 'test-game', options));
  }
  assert.deepEqual(p.calls, []);
});

test('cloud configuration forwards explicit false and the existing schema version without defaults', async () => {
  const p = platform({ updated: true });
  assert.equal(await configureCloudSaves(p, 'test-game', { enabled: false, schemaVersion: 7 }), p.response);
  assert.deepEqual(p.calls, [{ path: '/api/developer/game-integrations/test-game', options: {
    method: 'PUT', body: { feature: 'cloud-saves', enabled: false, schemaVersion: 7 },
  } }]);
});

test('leaderboard wrappers preserve the stable create key and mutable update fields exactly', async () => {
  const p = platform({ created: false, integration: { boardId } });
  const create = { key: 'best_score', name: 'Score', description: '', order: 'desc', unit: 'points', minScore: 0, maxScore: 100, minPlayMs: 0 };
  const update = { id: boardId, name: 'Best score', enabled: false };
  assert.equal(await configureLeaderboard(p, 'test-game', 'create', create), p.response);
  await configureLeaderboard(p, 'test-game', 'update', update);
  assert.deepEqual(p.calls, [
    { path: '/api/developer/game-integrations/test-game', options: { method: 'POST', body: { feature: 'leaderboards', action: 'create', board: create } } },
    { path: '/api/developer/game-integrations/test-game', options: { method: 'POST', body: { feature: 'leaderboards', action: 'update', board: update } } },
  ]);
  assert.equal(Object.hasOwn(p.calls[1].options.body.board, 'description'), false);
});

test('configuration conflicts and outages are returned intact and never retried as another mutation', async () => {
  for (const response of [{ error: 'Unavailable', code: 'READ_FAILED' }, { error: 'Different rules', code: 'BOARD_KEY_CONFLICT' }, { error: 'Login required', code: 'AUTH_REQUIRED' }]) {
    const p = platform(response);
    assert.equal(await getGameIntegrations(p, 'test-game'), response);
    assert.equal(await configureCloudSaves(p, 'test-game', { enabled: true, schemaVersion: 1 }), response);
    assert.equal(await configureLeaderboard(p, 'test-game', 'create', { key: 'score' }), response);
    assert.equal(p.calls.length, 3);
  }
  const offline = { request: async () => { throw new Error('Offline'); } };
  await assert.rejects(getGameIntegrations(offline, 'test-game'), /Offline/);
  await assert.rejects(configureCloudSaves(offline, 'test-game', { enabled: true, schemaVersion: 1 }), /Offline/);
});
