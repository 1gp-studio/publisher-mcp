import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGameMaterials, fillGameMaterials } from '../src/materials.js';

test('material inspection uses a single owned read without writes and preserves the server snapshot', async () => {
  const response = { game: { slug: 'demo' }, original: { locale: 'zh' }, languages: [], covers: { base: null } }, calls = [];
  const result = await getGameMaterials({ request: async (...args) => { calls.push(args); return response; } }, 'demo');
  assert.equal(result, response);
  assert.deepEqual(calls, [['/api/developer/game-materials/demo']]);
});

test('automatic material filling uses the non-overwriting endpoint and always forces fillMissing true', async () => {
  const calls = [], response = { ok: true, filled: { titles: ['ja'], descriptions: [] }, skipped: { titles: [], descriptions: [] } };
  const platform = { request: async (...args) => { calls.push(args); return response; } };
  const result = await fillGameMaterials(platform, 'demo', { titles: { ja: '猫' }, fillMissing: false });
  assert.equal(result, response);
  assert.deepEqual(calls, [['/api/developer/game-materials/demo', { method: 'PATCH', body: { titles: { ja: '猫' }, fillMissing: true } }]]);
});

test('mixed genre labels reach the platform intact through the fill-only endpoint', async () => {
  const calls = [];
  const response = { ok: true, filled: { tags: true }, skipped: { genre: true } };
  const result = await fillGameMaterials({ request: async (...args) => { calls.push(args); return response; } },
    'action-rpg', { genre: 'action', tags: ['放置', 'RPG'], fillMissing: false });
  assert.equal(result, response);
  assert.deepEqual(calls, [['/api/developer/game-materials/action-rpg', {
    method: 'PATCH', body: { genre: 'action', tags: ['放置', 'RPG'], fillMissing: true },
  }]]);
});

test('material tools reject unsafe slugs and fail closed for incomplete responses', async () => {
  let calls = 0;
  const platform = { request: async () => { calls++; return {}; } };
  for (const slug of ['../secret', 'demo?x=1', 'a'.repeat(201), '']) {
    assert.equal((await getGameMaterials(platform, slug)).code, 'INVALID_GAME_SLUG');
    assert.equal((await fillGameMaterials(platform, slug, {})).code, 'INVALID_GAME_SLUG');
  }
  assert.equal(calls, 0);
  assert.equal((await getGameMaterials(platform, 'demo')).code, 'PLATFORM_ERROR');
  assert.equal((await fillGameMaterials(platform, 'demo', {})).code, 'PLATFORM_ERROR');
  const denied = { error: 'Please connect', code: 'AUTH_REQUIRED' };
  assert.equal(await getGameMaterials({ request: async () => denied }, 'demo'), denied);
});
