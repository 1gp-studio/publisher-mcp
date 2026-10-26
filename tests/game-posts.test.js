import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGamePosts, editGamePost } from '../src/game-posts.js';

const postId = '11111111-1111-4111-8111-111111111111';
test('post edits need approval and an exact post, and send only the edited text', async () => {
  const calls = [];
  const platform = { request: async (path, options) => { calls.push([path, options]); return { gameSlug: 'demo', postId, saved: true, url: 'https://x/community/p/1' }; } };
  assert.equal((await editGamePost(platform, 'demo', { postId, title: 'T', body: 'B' })).code, 'APPROVAL_REQUIRED');
  assert.equal((await editGamePost(platform, 'demo', { postId: 'latest', title: 'T', body: 'B', approved: true })).code, 'INVALID_REQUEST');
  assert.equal((await editGamePost(platform, 'demo', { postId, title: ' ', body: 'B', approved: true })).code, 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
  assert.equal((await editGamePost(platform, 'demo', { postId, title: ' 春季更新 ', body: '新鱼。', approved: true })).saved, true);
  assert.deepEqual(calls, [['/api/developer/game-posts', { method: 'PATCH', body: { gameSlug: 'demo', postId, title: '春季更新', body: '新鱼。', approved: true } }]]);
  assert.equal((await editGamePost({ request: async () => ({ postId: 'other', saved: true }) }, 'demo', { postId, title: 'T', body: '', approved: true })).code, 'PLATFORM_ERROR');
});

test('post listing is validated before the MCP relies on post IDs', async () => {
  const good = { gameSlug: 'demo', posts: [{ postId, title: '首发', body: '', origin: 'launch' }] };
  assert.deepEqual(await getGamePosts({ request: async () => good }, 'demo'), good);
  assert.equal((await getGamePosts({ request: async () => ({ gameSlug: 'demo', posts: [{ postId: 'x', title: '', body: '' }] }) }, 'demo')).code, 'PLATFORM_ERROR');
  assert.equal((await getGamePosts({ request: async () => good }, 'Bad Slug')).code, 'INVALID_REQUEST');
});
