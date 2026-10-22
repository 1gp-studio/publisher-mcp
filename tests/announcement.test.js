import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGameAnnouncement, publishGameAnnouncement } from '../src/announcement.js';
const gameId = '11111111-1111-4111-8111-111111111111', postId = '22222222-2222-4222-8222-222222222222';
const state = () => ({ game: { id: gameId, slug: 'my-game', url: 'https://www.ai-made.games/games/my-game' },
  ready: true, eligible: true, launchReference: `build:${gameId}`, announcement: { status: 'missing' }, draft: { title: 'Game', body: 'Come play' } });

test('announcement preview is a single read and never publishes', async () => {
  const calls = [], value = state();
  const platform = { request: async (...args) => { calls.push(args); return value; } };
  assert.equal(await getGameAnnouncement(platform, 'my-game'), value);
  assert.deepEqual(calls, [['/api/developer/game-announcement/my-game']]);
});

test('announcement reads reject malformed successful responses rather than treating unknown state as missing', async () => {
  for (const value of [null, 'ok', [], {}, { ...state(), game: {} }, { ...state(), ready: undefined }, { ...state(), eligible: undefined },
    { ...state(), announcement: {} }, { ...state(), game: { ...state().game, slug: 'other-game' } },
    { ...state(), launchReference: gameId }, { ...state(), draft: null },
    { ...state(), announcement: { status: 'published', id: postId, url: 'http://unsafe.test' }, eligible: false }]) {
    assert.equal((await getGameAnnouncement({ request: async () => value }, 'my-game')).code, 'PLATFORM_ERROR');
  }
  for (const announcement of [{ status: 'published', id: postId, url: `https://www.ai-made.games/community/p/${postId}` }, { status: 'removed', id: postId }]) {
    const value = { ...state(), eligible: false, announcement, draft: null };
    assert.equal(await getGameAnnouncement({ request: async () => value }, 'my-game'), value);
  }
  const unavailable = { error: 'Unavailable', code: 'SERVICE_UNAVAILABLE' };
  assert.equal(await getGameAnnouncement({ request: async () => unavailable }, 'my-game'), unavailable);
});

test('announcement publishes require a confirmed post identity, HTTPS link and published state', async () => {
  const valid = { id: postId, url: `https://www.ai-made.games/community/p/${postId}`, status: 'published', created: true };
  const input = { title: 'Game', body: 'Come play', launchReference: `build:${gameId}`, approved: true };
  for (const value of [null, [], {}, { ok: true }, { ...valid, id: 'post' }, { ...valid, created: undefined },
    { ...valid, status: 'pending' }, { ...valid, url: 'http://unsafe.test' }, { ...valid, url: 'https://user:secret@example.test/post' }]) {
    assert.equal((await publishGameAnnouncement({ request: async () => value }, 'my-game', input)).code, 'PLATFORM_ERROR');
  }
  for (const created of [true, false]) {
    const value = { ...valid, created };
    assert.equal(await publishGameAnnouncement({ request: async () => value }, 'my-game', input), value);
  }
});

test('publishing forwards the author-approved snapshot once without inventing or retrying content', async () => {
  const calls = [], input = { title: 'Game', body: 'Come play', launchReference: 'build:11111111-1111-4111-8111-111111111111', approved: true };
  const platform = { request: async (...args) => { calls.push(args); return { code: 'SERVICE_UNAVAILABLE', error: 'Unknown outcome' }; } };
  const result = await publishGameAnnouncement(platform, 'my-game', input);
  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(calls, [['/api/developer/game-announcement/my-game', { method: 'POST', body: input }]]);
  for (const approved of [undefined, false, 'true']) await assert.rejects(publishGameAnnouncement(platform, 'my-game', { ...input, approved }), /explicitly approved/);
  assert.equal(calls.length, 1);
});

test('both announcement tools reject paths and invalid game identifiers before sending requests', async () => {
  const platform = { request: async () => assert.fail('Unexpected request') };
  for (const slug of ['../other', 'game?slug=other', 'game/other', 'a'.repeat(201), '', null]) {
    await assert.rejects(getGameAnnouncement(platform, slug), /Invalid game slug/);
    await assert.rejects(publishGameAnnouncement(platform, slug, { approved: true }), /Invalid game slug/);
  }
});

test('announcement URLs accept exact official legacy and AIWANNA origins but reject lookalike hosts',async()=>{
  const input={title:'Game',body:'Come play',launchReference:`build:${gameId}`,approved:true};
  for(const origin of ['https://www.ai-made.games','https://ai-made.games','https://www.aiwanna.games','https://aiwanna.games','https://1gp-game-platform.vercel.app']){
    const value={id:postId,url:`${origin}/community/p/${postId}`,status:'published',created:true};
    assert.equal(await publishGameAnnouncement({request:async()=>value},'my-game',input),value);
    const preview={...state(),game:{...state().game,url:`${origin}/games/my-game`}};
    assert.equal(await getGameAnnouncement({request:async()=>preview},'my-game'),preview);
  }
  for(const origin of ['https://www.aiwanna.games.evil.test','https://other.aiwanna.games','https://aiwanna.games:444','http://aiwanna.games','https://evil.test']){
    const value={id:postId,url:`${origin}/community/p/${postId}`,status:'published',created:true};
    assert.equal((await publishGameAnnouncement({request:async()=>value},'my-game',input)).code,'PLATFORM_ERROR');
  }
});
