import test from 'node:test';
import assert from 'node:assert/strict';
import { setGameDetails, setGameTopic } from '../src/languages.js';

const platform = (reply = { state: 'joined' }) => { const calls = []; return { calls, request: async (path, options) => { calls.push({ path, ...options }); return reply; } }; };

test('set_game_details topic joins or leaves a topic through the game topics API', async () => {
  const joined = platform();
  assert.deepEqual(await setGameDetails(joined, 'my-game', { topic: { slug: 'halloween-2026' } }), { ok: true, topic: { saved: true, topic: 'halloween-2026', state: 'joined' } });
  assert.deepEqual(joined.calls, [{ path: '/api/games/my-game/topics', method: 'POST', body: { topic: 'halloween-2026', joined: true } }]);
  const left = platform({ state: null });
  assert.equal((await setGameTopic(left, 'my-game', { slug: 'halloween-2026', joined: false })).state, null);
  assert.equal(left.calls[0].body.joined, false);
});

test('a refused topic is reported without hiding the reason', async () => {
  const refused = platform({ error: '这个游戏被移出了专题，不能自己再加入。' });
  assert.deepEqual(await setGameTopic(refused, 'my-game', { slug: 'halloween-2026' }), { saved: false, error: '这个游戏被移出了专题，不能自己再加入。' });
});
