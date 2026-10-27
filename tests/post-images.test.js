import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadPostImage } from '../src/post-images.js';
import { createGamePost } from '../src/game-posts.js';
import { prepareGameUpdate, publishGameUpdate, completeGameUpdate } from '../src/game-updates.js';

const postId = '22222222-2222-4222-8222-222222222222', buildId = '33333333-3333-4333-8333-333333333333';
const storedPath = '44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555.webp';
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const launchReference = `build:${buildId}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'post-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), directory = join(root, 'config');
  await mkdir(project); await mkdir(directory);
  await writeFile(join(project, 'poster.png'), await sharp({ create: { width: 2400, height: 2620, channels: 3, background: 'orange' } }).png().toBuffer());
  await writeFile(join(project, 'notes.txt'), 'not a picture');
  const uploads = [], requests = [], state = { token: 'a'.repeat(64) };
  const platform = { origin: 'https://1gp-game-platform.vercel.app', directory, token: async () => state.token,
    uploadBytes: async (path, bytes, options) => {
      uploads.push({ path, bytes, options });
      assert.equal(options.idempotencyKey, fingerprint(bytes)); assert.equal(options.type, 'image/webp');
      const { width, height } = await sharp(bytes).metadata();
      return state.upload ?? { path: storedPath, width, height, sig: 'f'.repeat(64) };
    },
    request: async (path, options) => {
      requests.push({ path, options });
      if (path === '/api/developer/game-updates') return { created: true, update: { id: options.body.updateId, gameSlug: 'owned-game', state: 'open' } };
      if (path.endsWith('/complete')) return { updateId: path.split('/')[4], gameSlug: 'owned-game', status: 'published', created: true, version: '1.2.0',
        post: { id: postId, url: `https://www.ai-made.games/community/p/${postId}` } };
      if (path.startsWith('/api/developer/game-announcement/')) return { id: postId, url: `https://www.ai-made.games/community/p/${postId}`, status: 'published', created: true };
      throw new Error(`Unexpected path ${path}`);
    } };
  return { project, platform, uploads, requests, state };
}

test('a post picture is read from the project, sent as WebP within 1600 px and returned as a signed reference', async t => {
  const f = await fixture(t);
  const result = await uploadPostImage(f.platform, f.project, 'poster.png', 'launch:owned-game', 'a'.repeat(64));
  assert.equal(result.file, 'poster.png');
  assert.deepEqual(result.image, { path: storedPath, width: 1466, height: 1600, sig: 'f'.repeat(64) });
  assert.equal(f.uploads[0].path, '/api/developer/post-images?for=launch%3Aowned-game');
  assert.equal(f.uploads[0].options.token, 'a'.repeat(64));
  // The same file gives the same bytes, so the platform stores it once for this post.
  await uploadPostImage(f.platform, f.project, 'poster.png', 'launch:owned-game', 'a'.repeat(64));
  assert.equal(f.uploads[1].options.idempotencyKey, f.uploads[0].options.idempotencyKey);
});

test('missing, escaping or non-image paths and incomplete platform answers are refused without posting', async t => {
  const f = await fixture(t);
  for (const path of ['', 'missing.png', '../outside.png', 'notes.txt']) {
    assert.equal((await uploadPostImage(f.platform, f.project, path, 'launch:owned-game', 'a'.repeat(64))).code, 'INVALID_IMAGE', path);
  }
  assert.equal((await uploadPostImage(f.platform, undefined, 'poster.png', 'launch:owned-game', 'a'.repeat(64))).code, 'INVALID_IMAGE');
  for (const answer of [{}, { path: 'x.webp', width: 1, height: 1, sig: 'f'.repeat(64) }, { path: storedPath, width: 0, height: 1, sig: 'f'.repeat(64) }, { path: storedPath, width: 1, height: 1, sig: 'nope' }]) {
    f.state.upload = answer;
    assert.equal((await uploadPostImage(f.platform, f.project, 'poster.png', 'launch:owned-game', 'a'.repeat(64))).code, 'PLATFORM_ERROR');
  }
  f.state.upload = { code: 'INVALID_IMAGE', error: 'Bad picture' };
  assert.deepEqual(await uploadPostImage(f.platform, f.project, 'poster.png', 'launch:owned-game', 'a'.repeat(64)), f.state.upload);
});

test('a new post uploads its pictures first and sends them with the approved text', async t => {
  const f = await fixture(t);
  f.platform.request = async (path, options) => { f.requests.push({ path, options }); return { postId, created: true, url: `https://www.ai-made.games/community/p/${postId}` }; };
  const input = { gameSlug: 'owned-game', kind: 'chat', title: 'Fishy Tails', body: 'Come fish', approved: true };
  assert.equal((await createGamePost(f.platform, { ...input, images: ['poster.png'], projectDirectory: f.project })).created, true);
  assert.match(f.uploads[0].path, /^\/api\/developer\/post-images\?for=new%3A[a-f0-9]{32}$/);
  assert.deepEqual(f.requests.at(-1).options.body, { ...input, images: [{ path: storedPath, width: 1466, height: 1600, sig: 'f'.repeat(64) }] });
  // A failed upload never posts the text alone.
  const before = f.requests.length; f.state.upload = { code: 'SERVICE_UNAVAILABLE', error: 'Down' };
  assert.equal((await createGamePost(f.platform, { ...input, images: ['poster.png'], projectDirectory: f.project })).code, 'SERVICE_UNAVAILABLE');
  assert.equal(f.requests.length, before);
});

test('an update completion writes the version record only and sends no post', async t => {
  const f = await fixture(t);
  const update = await prepareGameUpdate(f.platform, f.project, { gameSlug: 'owned-game' });
  await publishGameUpdate(f.platform, { projectDirectory: f.project, gameSlug: 'owned-game', updateId: update.id }, async () => ({ id: buildId, state: 'ready' }));
  const draft = await completeGameUpdate(f.platform, f.project, { updateId: update.id, title: 'Spring', notes: 'New fish.' });
  assert.equal(draft.code, 'APPROVAL_REQUIRED'); assert.deepEqual(draft.draft, { title: 'Spring', notes: 'New fish.' });
  const done = await completeGameUpdate(f.platform, f.project, { updateId: update.id, title: 'Spring', notes: 'New fish.', approved: true });
  assert.equal(done.status, 'published');
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.requests.at(-1).options.body, { title: 'Spring', notes: 'New fish.', approved: true, post: false });
});
