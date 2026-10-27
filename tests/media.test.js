import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, link, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { editGameMedia, setGameMedia } from '../src/media.js';
import { readProjectFile, inspectProjectFile } from '../src/media-files.js';
import { testSymlink } from './helpers/symlink.js';

const gameId = '11111111-1111-4111-8111-111111111111', mediaId = '22222222-2222-4222-8222-222222222222';
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const image = async (color = 'red') => sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).png().toBuffer();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'cover.png'), await image()); await writeFile(join(project, 'shot.png'), await image('blue'));
  const gif = await sharp(await image()).gif().toBuffer(); await writeFile(join(project, 'preview.gif'), gif);
  const calls = [], receipts = new Map(), state = { token: 'a'.repeat(64) };
  const platform = { origin: 'https://1gp-game-platform.vercel.app', token: async () => state.token,
    uploadBytes: async (path, bytes, options) => {
      calls.push({ kind: 'image', path, bytes, options });
      assert.equal(options.idempotencyKey, fingerprint(bytes)); assert.equal(options.type, 'image/webp');
      const target = path.includes('/screenshots') ? 'screenshot' : 'cover', key = `${target}:${options.idempotencyKey}`;
      if (receipts.has(key)) return { ...receipts.get(key), created: false, reason: 'IDEMPOTENT_REPLAY' };
      const data = { ok: true, created: true, skipped: false, src: `/api/${target === 'cover' ? 'game-covers' : 'game-shots'}/${gameId}/${mediaId}.webp`, ...(target === 'screenshot' ? { id: mediaId, width: 32, height: 24 } : {}) };
      receipts.set(key, data); return data;
    },
    request: async (path, options) => {
      calls.push({ kind: options.body.action, path, options });
      const key = `preview:${options.idempotencyKey}`;
      if (receipts.has(key)) return { ...receipts.get(key), created: false, reason: 'IDEMPOTENT_REPLAY' };
      if (options.body.action === 'sign') {
        const mediaPath = `${gameId}/${mediaId}.gif`;
        return { path: mediaPath, signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/game-preview-uploads/${mediaPath}?token=private-storage-signature` };
      }
      const data = { ok: true, created: true, skipped: false, src: `/api/game-previews/${gameId}/${mediaId}.gif` };
      receipts.set(key, data); return data;
    } };
  return { root, project, calls, receipts, state, platform, gif };
}

test('real media batches normalize images, append screenshots and use credential-free signed preview upload', async t => {
  const f = await fixture(t), puts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { puts.push({ url, options }); return new Response('{}', { status: 200 }); });
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png'], preview: 'preview.gif' });
  assert.equal(result.ok, true); assert.equal(result.partial, false);
  assert.deepEqual(result.uploaded.map(item => item.target), ['cover', 'screenshot', 'preview']);
  assert.equal(f.calls[0].path, '/api/games/owned-game/cover?fillMissing=true');
  assert.equal(f.calls[1].path, '/api/games/owned-game/screenshots');
  assert.ok(f.calls.every(call => call.options.token === f.state.token));
  assert.deepEqual(f.calls[2].options.body, { action: 'sign', type: 'image/gif', size: f.gif.length, fillMissing: true });
  assert.equal(f.calls[2].options.idempotencyKey, fingerprint(f.gif));
  assert.equal(f.calls[3].options.idempotencyKey, f.calls[2].options.idempotencyKey);
  assert.deepEqual(puts[0].options.headers, { 'Content-Type': 'image/gif', 'x-upsert': 'false' });
  assert.equal(puts[0].options.redirect, 'error'); assert.deepEqual(puts[0].options.body, f.gif);
  assert.equal(JSON.stringify(result).includes('private-storage-signature'), false);
  assert.equal(JSON.stringify(result).includes(f.state.token), false);
  const again = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png'], preview: 'preview.gif' });
  assert.equal(again.ok, true); assert.ok(again.uploaded.every(item => item.created === false));
  assert.equal(puts.length, 1, 'A confirmed preview retry reuses its server receipt without uploading again');
  assert.equal(f.receipts.size, 3, 'Identical retries add no second screenshot or preview');
});

test('every file is validated before the first write; suffixes do not establish actual media type', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'fake.png'), '<html>not a picture</html>');
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png', 'fake.png'] });
  assert.equal(result.ok, false); assert.equal(result.partial, false); assert.deepEqual(result.uploaded, []); assert.equal(f.calls.length, 0);
  await writeFile(join(f.project, 'broken.png'), Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]));
  assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'broken.png' })).ok, false);
  assert.equal(f.calls.length, 0);
  await writeFile(join(f.project, 'actual-jpeg.png'), await sharp(await image()).jpeg().toBuffer());
  assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'actual-jpeg.png' })).ok, true);
});

test('input size/pixels, links and project-relative boundaries are checked before uploading', async t => {
  const f = await fixture(t), outside = join(f.root, 'private.png'); await writeFile(outside, await image());
  await link(outside, join(f.project, 'hard.png'));
  await writeFile(join(f.project, 'large.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await writeFile(join(f.project, 'huge.png'), await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'red' } }).png().toBuffer());
  for (const path of ['../private.png', outside, 'C:private.png', 'cover.png:hidden', 'cov\ner.png', 'cover\u202e.png', 'hard.png', 'large.png', 'huge.png']) {
    const response = await setGameMedia(f.platform, f.project, 'owned-game', { cover: path });
    assert.equal(response.ok, false, path);
  }
  assert.equal(f.calls.length, 0);
  if (!await testSymlink(t, f.root, join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'linked/private.png' })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('one captured batch is used even if later files change during the first upload', async t => {
  const f = await fixture(t), upload = f.platform.uploadBytes;
  f.platform.uploadBytes = async (...args) => { await writeFile(join(f.project, 'shot.png'), 'changed after validation'); return upload(...args); };
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png', 'shot.png'] });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 2);
  assert.equal(result.skipped[0].reason, 'DUPLICATE_SELECTION');
  assert.equal((await sharp(f.calls[1].bytes).metadata()).format, 'webp');
});

test('partial failures preserve real completed uploads and stop subsequent writes', async t => {
  const f = await fixture(t), upload = f.platform.uploadBytes;
  f.platform.uploadBytes = async (...args) => args[0].includes('screenshots') ? { code: 'SCREENSHOT_LIMIT', error: 'No room', signedUrl: 'must-not-leak' } : upload(...args);
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png'], preview: 'preview.gif' });
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.code, 'SCREENSHOT_LIMIT');
  assert.deepEqual(result.uploaded.map(item => item.target), ['cover']); assert.equal(result.failed.target, 'screenshot');
  assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('partial results track completed input entries despite normalized path spelling and duplicate selections', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, 'shots')); await writeFile(join(f.project, 'shots', '01.png'), await image('blue'));
  f.platform.request = async () => ({ code: 'SERVICE_UNAVAILABLE', error: 'Preview signing failed' });
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: './cover.png', screenshots: [join('shots', '01.png')], preview: './preview.gif' });
  assert.equal(result.partial, true); assert.equal(result.uploaded.length, 2);
  assert.deepEqual(result.uploaded.map(item => item.path), ['cover.png', 'shots/01.png']);
  assert.deepEqual(result.pending, [{ target: 'preview', path: 'preview.gif' }]);
  f.platform.uploadBytes = async () => ({ code: 'SCREENSHOT_LIMIT', error: 'No room' });
  const duplicate = await setGameMedia(f.platform, f.project, 'owned-game', { screenshots: ['./shot.png', 'shot.png'] });
  assert.equal(duplicate.ok, false); assert.equal(duplicate.skipped[0].reason, 'DUPLICATE_SELECTION');
  assert.deepEqual(duplicate.pending, [{ target: 'screenshot', path: 'shot.png' }], 'Skipping a duplicate must not hide the failed original selection');
});

test('author media and explicitly disabled preview are preserved and reported as skips', async t => {
  const f = await fixture(t);
  f.platform.uploadBytes = async () => ({ ok: true, created: false, skipped: true, reason: 'EXISTING_MEDIA_PRESERVED', src: `/api/game-covers/${gameId}/${mediaId}.webp` });
  f.platform.request = async () => ({ ok: true, skipped: true, reason: 'AUTHOR_DISABLED', src: null });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('A preserved preview must not upload'));
  const done = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', preview: 'preview.gif' });
  assert.equal(done.ok, true); assert.deepEqual(done.uploaded, []);
  assert.deepEqual(done.skipped.map(item => item.reason), ['EXISTING_MEDIA_PRESERVED', 'AUTHOR_DISABLED']);
  f.platform.request = async () => ({ ok: true, created: false, skipped: true, reason: 'CURRENT_MEDIA_CHANGED', src: null });
  const changed = await setGameMedia(f.platform, f.project, 'owned-game', { preview: 'preview.gif' });
  assert.equal(changed.ok, true); assert.equal(changed.skipped[0].reason, 'CURRENT_MEDIA_CHANGED');
});

test('account switches stop remaining media writes and keep earlier results under the captured account', async t => {
  const f = await fixture(t), original = f.state.token, upload = f.platform.uploadBytes;
  f.platform.uploadBytes = async (...args) => { const result = await upload(...args); f.state.token = 'b'.repeat(64); return result; };
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png'] });
  assert.equal(result.code, 'ACCOUNT_CHANGED'); assert.equal(result.partial, true); assert.equal(result.uploaded.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.token, original);
});

test('signed previews reject untrusted hosts, paths, credentials, redirects and malformed success', async t => {
  const f = await fixture(t), mediaPath = `${gameId}/${mediaId}.gif`;
  let fetches = 0; t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('{}', { status: 200 }); });
  const urls = [
    `https://evil.example/storage/v1/object/upload/sign/game-preview-uploads/${mediaPath}?token=secret`,
    `https://project.supabase.co.evil.example/storage/v1/object/upload/sign/game-preview-uploads/${mediaPath}?token=secret`,
    `https://author:password@project.supabase.co/storage/v1/object/upload/sign/game-preview-uploads/${mediaPath}?token=secret`,
    `https://project.supabase.co/storage/v1/object/upload/sign/other-bucket/${mediaPath}?token=secret`,
    `http://project.supabase.co/storage/v1/object/upload/sign/game-preview-uploads/${mediaPath}?token=secret`,
  ];
  for (const signedUrl of urls) {
    f.platform.request = async () => ({ path: mediaPath, signedUrl });
    assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { preview: 'preview.gif' })).code, 'UNSAFE_UPLOAD_URL');
  }
  assert.equal(fetches, 0);
  f.platform.uploadBytes = async () => ({ ok: true, created: true, skipped: false, src: null });
  assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png' })).code, 'PLATFORM_ERROR');
  f.platform.uploadBytes = async () => ({ code: 'MEDIA_REMOVED', error: 'Author removed this file', status: 410 });
  const removed = await setGameMedia(f.platform, f.project, 'owned-game', { screenshots: ['shot.png'] });
  assert.equal(removed.code, 'MEDIA_REMOVED'); assert.equal(removed.status, 410); assert.equal(removed.ok, false);
});

test('shared project-file readers reject handle replacement and growth; discovery does not read media bytes', async t => {
  const f = await fixture(t), path = join(f.project, 'cover.png'), handle = await open(path), prototype = Object.getPrototypeOf(handle), read = prototype.read;
  await handle.close();
  let reads = 0;
  t.mock.method(prototype, 'read', async function(...args) { reads++; return read.apply(this, args); });
  const metadata = await inspectProjectFile(f.project, 'cover.png', 20 * 1024 * 1024);
  assert.equal(metadata.name, 'cover.png'); assert.equal(metadata.bytes, undefined); assert.equal(reads, 0);
  t.mock.restoreAll();
  let changed = false;
  t.mock.method(prototype, 'read', async function(...args) {
    if (!changed) { changed = true; await rename(path, join(f.project, 'old.png')); await writeFile(path, await image('green')); }
    return read.apply(this, args);
  });
  await assert.rejects(readProjectFile(f.project, 'cover.png', 20 * 1024 * 1024), /替换|改变/);
  t.mock.restoreAll(); changed = false;
  t.mock.method(prototype, 'read', async function(...args) {
    if (!changed) { changed = true; await writeFile(path, Buffer.alloc(2049)); }
    return read.apply(this, args);
  });
  await assert.rejects(readProjectFile(f.project, 'cover.png', 2048), /改变|限制/);
});

test('media saved URLs accept exact official legacy and AIWANNA origins without accepting lookalikes',async t=>{
  const f=await fixture(t);
  for(const origin of ['https://www.ai-made.games','https://ai-made.games','https://www.aiwanna.games','https://aiwanna.games','https://1gp-game-platform.vercel.app']){
    f.platform.uploadBytes=async()=>({ok:true,created:true,skipped:false,src:`${origin}/api/game-covers/${gameId}/${mediaId}.webp`});
    assert.equal((await setGameMedia(f.platform,f.project,'owned-game',{cover:'cover.png'})).ok,true,origin);
  }
  for(const origin of ['https://aiwanna.games.evil.test','https://other.aiwanna.games','http://aiwanna.games','https://aiwanna.games:444']){
    f.platform.uploadBytes=async()=>({ok:true,created:true,skipped:false,src:`${origin}/api/game-covers/${gameId}/${mediaId}.webp`});
    assert.equal((await setGameMedia(f.platform,f.project,'owned-game',{cover:'cover.png'})).code,'PLATFORM_ERROR',origin);
  }
});

test('replaceCover uploads the reviewed cover as the new main cover; it needs an explicit true and a cover', async t => {
  const f = await fixture(t);
  const replaced = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png', screenshots: ['shot.png'], replaceCover: true });
  assert.equal(replaced.ok, true);
  assert.equal(f.calls[0].path, '/api/games/owned-game/cover', 'Replacing omits fillMissing, as the edit page does');
  assert.equal(f.calls[1].path, '/api/games/owned-game/screenshots', 'Screenshots still only append');
  assert.deepEqual(replaced.uploaded.map(item => [item.target, item.created]), [['cover', true], ['screenshot', true]]);
  assert.match(replaced.message, /替换主封面/);
  const calls = f.calls.length;
  for (const input of [{ replaceCover: true, screenshots: ['shot.png'] }, { cover: 'cover.png', replaceCover: false }, { cover: 'cover.png', replaceCover: 'yes' }]) {
    const result = await setGameMedia(f.platform, f.project, 'owned-game', input);
    assert.equal(result.code, 'INVALID_MEDIA'); assert.equal(f.calls.length, calls, 'Rejected before reading or uploading anything');
  }
  const kept = await setGameMedia(f.platform, f.project, 'owned-game', { cover: 'cover.png' });
  assert.equal(f.calls.at(-1).path, '/api/games/owned-game/cover?fillMissing=true', 'Without replaceCover the main cover is only filled');
  assert.equal(kept.ok, true);
});

test('replacePreview uploads the reviewed preview without fillMissing; it needs an explicit true and a preview', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const replaced = await setGameMedia(f.platform, f.project, 'owned-game', { preview: 'preview.gif', replacePreview: true });
  assert.equal(replaced.ok, true);
  assert.deepEqual(f.calls.map(call => call.options.body.fillMissing), [false, false], 'sign and complete both replace');
  assert.match(replaced.message, /替换预览/);
  for (const input of [{ cover: 'cover.png', replacePreview: true }, { preview: 'preview.gif', replacePreview: false }]) {
    const calls = f.calls.length, result = await setGameMedia(f.platform, f.project, 'owned-game', input);
    assert.equal(result.code, 'INVALID_MEDIA'); assert.equal(f.calls.length, calls);
  }
});

test('edit_game_media deletes screenshots, orders the given ids first and takes the preview down', async () => {
  const ids = ['a', 'b', 'c', 'd'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
  let shots = [...ids];
  const calls = [];
  const platform = { token: async () => 'token', request: async (path, options = {}) => {
    calls.push({ path, method: options.method ?? (options.body ? 'POST' : 'GET'), body: options.body });
    if (options.method === 'DELETE') {
      const id = new URL(path, 'https://x').searchParams.get('id');
      if (!shots.includes(id)) return { error: '找不到这张截图。', code: 'PLATFORM_ERROR', status: 404 };
      shots = shots.filter(item => item !== id); return { ok: true };
    }
    if (path.startsWith('/api/developer/game-materials/')) return { media: { screenshots: { items: shots.map(id => ({ id })) } } };
    if (options.method === 'PATCH') { shots = options.body.order; return { ok: true }; }
    return { ok: true };
  } };
  const result = await editGameMedia(platform, 'owned-game', { removeScreenshots: [ids[0], 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'], screenshotOrder: [ids[3]], removePreview: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removedScreenshots, [ids[0]]);
  assert.deepEqual(result.notFound, ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'], 'An already removed screenshot is reported, not an error');
  assert.deepEqual(result.screenshotOrder, [ids[3], ids[1], ids[2]], 'Ids not listed keep their order after the given ones');
  assert.equal(result.previewRemoved, true);
  assert.deepEqual(calls.at(-1), { path: '/api/games/owned-game/preview', method: 'POST', body: { action: 'remove' } });

  const unknown = await editGameMedia(platform, 'owned-game', { screenshotOrder: [ids[0]] });
  assert.equal(unknown.code, 'UNKNOWN_SCREENSHOT');
  for (const input of [{}, { removeScreenshots: ['not-an-id'] }, { removePreview: false }, { removeScreenshots: [ids[1]], screenshotOrder: [ids[1]] }]) {
    const count = calls.length, rejected = await editGameMedia(platform, 'owned-game', input);
    assert.equal(rejected.code, 'INVALID_MEDIA'); assert.equal(calls.length, count, 'Rejected before any request');
  }
});

test('replaceScreenshots swaps the whole set for the given pictures, in order', async t => {
  const f = await fixture(t);
  const old = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  let shots = [...old];
  const edits = [];
  const upload = f.platform.request;
  const bytes = f.platform.uploadBytes;
  f.platform.uploadBytes = async (...args) => { const data = await bytes(...args); if (data.id && !shots.includes(data.id)) shots.push(data.id); return data; };
  f.platform.request = async (path, options = {}) => {
    if (path.startsWith('/api/developer/game-materials/')) return { media: { screenshots: { items: shots.map(id => ({ id })) } } };
    if (options.method === 'DELETE') { const id = new URL(path, 'https://x').searchParams.get('id'); shots = shots.filter(item => item !== id); edits.push(['delete', id]); return { ok: true }; }
    if (options.method === 'PATCH') { edits.push(['order', options.body.order]); return { ok: true }; }
    return upload(path, options);
  };
  const result = await setGameMedia(f.platform, f.project, 'owned-game', { screenshots: ['shot.png'], replaceScreenshots: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(edits.filter(([kind]) => kind === 'delete').map(([, id]) => id), old, 'the old screenshots are removed after the new one is in');
  assert.deepEqual(edits.at(-1), ['order', [mediaId]]);
  assert.equal((await setGameMedia(f.platform, f.project, 'owned-game', { replaceScreenshots: true })).code, 'INVALID_MEDIA');
});
