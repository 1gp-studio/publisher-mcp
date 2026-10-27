import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGamePosts, editGamePost, createGamePost } from '../src/game-posts.js';

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

test('a new post goes out once the author approved it; stored pictures stay on edit', async () => {
  const calls = [];
  const platform = { token: async () => 'token', request: async (path, options) => { calls.push([path, options]);
    return options.method === 'POST' ? { postId, created: true, url: 'https://x/community/p/1' } : { gameSlug: 'demo', postId, saved: true }; } };
  assert.equal((await createGamePost(platform, { kind: 'chat', title: '周末活动', body: '双倍金币' })).code, 'APPROVAL_REQUIRED');
  assert.equal((await createGamePost(platform, { kind: 'news', title: 'x', approved: true })).code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
  const sent = await createGamePost(platform, { gameSlug: 'demo', kind: 'chat', title: ' 周末活动 ', body: '双倍金币', approved: true });
  assert.equal(sent.created, true);
  assert.deepEqual(calls[0], ['/api/developer/game-posts', { method: 'POST', body: { gameSlug: 'demo', kind: 'chat', title: '周末活动', body: '双倍金币', images: [], approved: true } }]);
  const kept = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp';
  await editGamePost(platform, 'demo', { postId, title: 'T', body: 'B', images: [kept], approved: true });
  assert.deepEqual(calls.at(-1)[1].body.images, [{ path: kept }], 'A stored picture is kept by its path, nothing uploaded');
  await editGamePost(platform, 'demo', { postId, title: 'T', body: 'B', approved: true });
  assert.equal('images' in calls.at(-1)[1].body, false, 'Left out, the pictures stay');
});
