import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGameUpdate, publishGameUpdate, completeGameUpdate } from '../src/game-updates.js';
import { publishWithTracking } from '../src/publish-progress.js';
import { testSymlink } from './helpers/symlink.js';

const postId = '11111111-1111-4111-8111-111111111111';
const buildId = '22222222-2222-4222-8222-222222222222';
const title = 'Features and fixes', notes = 'Cloud saves and leaderboard are verified.';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-updates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), directory = join(root, 'config');
  await mkdir(project); await mkdir(directory);
  const requests = [], state = { token: 'a'.repeat(64), submitCalls: 0, completeStatus: 'published', registerState: 'open' };
  const platform = { origin: 'https://1gp-game-platform.vercel.app', directory, token: async () => state.token,
    request: async (path, options) => {
      requests.push({ path, options });
      if (path === '/api/developer/game-updates') {
        if (state.registerError) throw new Error('Lost response');
        if (state.switchOnRegister) state.token = 'b'.repeat(64);
        return state.registration ?? { created: true, update: { id: options.body.updateId, gameSlug: options.body.gameSlug ?? null, state: state.registerState } };
      }
      if (path.endsWith('/complete')) {
        if (state.completeError) throw new Error('Lost response');
        if (state.switchOnComplete) state.token = 'b'.repeat(64);
        return state.completion ?? { updateId: path.split('/')[4], gameSlug: 'owned-game', status: state.completeStatus,
          created: state.completed !== true, version: '1.0.2', post: state.completeStatus === 'published' ? { id: postId, url: `${state.postOrigin??'https://www.ai-made.games'}/community/p/${postId}` } : null };
      }
      throw new Error(`Unexpected path ${path}`);
    } };
  const prepare = options => prepareGameUpdate(platform, project, { gameSlug: 'owned-game', ...options });
  const publish = id => publishGameUpdate(platform, { projectDirectory: project, gameSlug: 'owned-game', updateId: id }, async () => { state.submitCalls++; return { id: buildId, state: 'ready' }; });
  const complete = id => completeGameUpdate(platform, project, { updateId: id, title, notes });
  return { root, project, directory, platform, requests, state, prepare, publish, complete };
}

test('preparation is local and durable; deployed updates require explicit resume; completion starts a fresh task', async t => {
  const f = await fixture(t), first = await f.prepare();
  assert.equal(first.registered, false); assert.equal(first.resumed, false); assert.equal(f.requests.length, 0);
  assert.equal((await f.prepare()).id, first.id, 'An unused local draft can be reused');
  assert.equal((await f.publish(first.id)).updateId, first.id);
  const resumedPlatform = { ...f.platform };
  const unfinished = await prepareGameUpdate(resumedPlatform, f.project, { gameSlug: 'owned-game' });
  assert.equal(unfinished.code, 'UPDATE_IN_PROGRESS'); assert.equal(unfinished.update.id, first.id);
  assert.equal((await f.prepare({ updateId: first.id })).id, first.id);
  assert.equal((await f.publish(first.id)).updateId, first.id);
  assert.equal(f.state.submitCalls, 2);
  assert.ok(f.requests.every(r => r.options.body.updateId === first.id));
  // The public site differs from the default MCP transport host; this is a real successful response.
  assert.equal((await f.complete(first.id)).status, 'published');
  f.state.completed = true;
  assert.equal((await f.complete(first.id)).created, false, 'Retry after cleanup reaches the same server id');
  assert.notEqual((await f.prepare()).id, first.id);
});

test('account, platform, project and game boundaries never share an active update', async t => {
  const f = await fixture(t), a = await f.prepare();
  f.state.token = 'b'.repeat(64); const b = await f.prepare();
  assert.notEqual(a.id, b.id);
  assert.equal((await f.publish(a.id)).code, 'UPDATE_MISMATCH');
  f.state.token = 'a'.repeat(64);
  assert.equal((await f.prepare({ gameSlug: 'other-game', updateId: a.id })).code, 'UPDATE_MISMATCH');
  const other = join(f.root, 'other'); await mkdir(other);
  assert.equal((await publishGameUpdate(f.platform, { projectDirectory: other, updateId: a.id }, () => assert.fail())).code, 'UPDATE_MISMATCH');
  f.platform.origin = 'https://another.example'; assert.notEqual((await f.prepare()).id, a.id);
  assert.equal(f.requests.length, 0);
});

test('registration uncertainty preserves the same UUID and never submits a deployment', async t => {
  const f = await fixture(t), first = await f.prepare();
  f.state.registerError = true;
  assert.equal((await f.publish(first.id)).code, 'UPDATE_STATUS_UNKNOWN');
  assert.equal(f.state.submitCalls, 0);
  assert.equal((await f.prepare()).code, 'UPDATE_IN_PROGRESS');
  f.state.registerError = false;
  assert.equal((await f.publish(first.id)).updateId, first.id);
  assert.deepEqual(f.requests.map(r => r.options.body.updateId), [first.id, first.id]);
});

test('explicit new tasks receive a new ID while malformed or completed registration cannot deploy', async t => {
  const f = await fixture(t), first = await f.prepare(); await f.publish(first.id);
  const next = await f.prepare({ newUpdate: true });
  assert.notEqual(next.id, first.id); assert.equal(next.previousUpdateId, first.id);
  assert.equal((await f.publish(first.id)).code, 'UPDATE_MISMATCH');
  f.state.registerState = 'completed';
  assert.equal((await f.publish(next.id)).code, 'UPDATE_COMPLETED');
  f.state.registration = { created: true, update: { id: postId, state: 'open', gameSlug: 'owned-game' } };
  assert.equal((await f.publish(next.id)).code, 'PLATFORM_ERROR');
  assert.equal(f.state.submitCalls, 1);
});

test('the actual nested publish tracking wrapper notices credential changes before submission', async t => {
  const f = await fixture(t), first = await f.prepare(), token = f.state.token;
  f.state.switchOnRegister = true;
  const response = await publishWithTracking(f.platform, { channel: 'local', gameSlug: 'owned-game' }, client =>
    publishGameUpdate(client, { projectDirectory: f.project, gameSlug: 'owned-game', updateId: first.id }, async () => { f.state.submitCalls++; return { id: buildId, state: 'ready' }; }));
  assert.equal(response.code, 'ACCOUNT_CHANGED'); assert.equal(f.state.submitCalls, 0);
  assert.ok(f.requests.every(request => request.options.token === token));
  assert.equal((await f.prepare()).registered, false, 'The new account starts its own unused draft');
});

test('malformed completion, unready errors, removed posts and uncertain responses preserve recovery state', async t => {
  const f = await fixture(t), first = await f.prepare(); await f.publish(first.id);
  const invalid = [
    { updateId: first.id, gameSlug: 'owned-game', status: 'published', created: true, post: null },
    { updateId: postId, gameSlug: 'owned-game', status: 'launch_skipped', created: true, post: null },
    { updateId: first.id, gameSlug: 'other-game', status: 'launch_skipped', created: true, post: null },
    { updateId: first.id, gameSlug: 'owned-game', status: 'pending', created: true, post: null },
  ];
  for (const response of invalid) {
    f.state.completion = response;
    assert.equal((await f.complete(first.id)).code, 'PLATFORM_ERROR');
    assert.equal((await f.prepare({ updateId: first.id })).id, first.id);
  }
  for (const code of ['UPDATE_NOT_READY', 'POST_REMOVED']) {
    f.state.completion = { code, error: 'Cannot finish' };
    assert.equal((await f.complete(first.id)).code, code);
    assert.equal((await f.prepare()).code, 'UPDATE_IN_PROGRESS');
  }
  delete f.state.completion; f.state.completeError = true;
  assert.equal((await f.complete(first.id)).code, 'UPDATE_STATUS_UNKNOWN');
  assert.equal(f.state.submitCalls, 1, 'Completion never invokes publication');
  f.state.completeError = false; f.state.completeStatus = 'launch_skipped';
  assert.equal((await f.complete(first.id)).post, null);
  assert.notEqual((await f.prepare()).id, first.id);
});

test('completion during an account switch returns confirmed success but retains the original account record', async t => {
  const f = await fixture(t), first = await f.prepare(), token = f.state.token; await f.publish(first.id);
  f.state.switchOnComplete = true;
  const completed = await f.complete(first.id);
  assert.equal(completed.status, 'published'); assert.equal(completed.warning.code, 'ACCOUNT_CHANGED');
  assert.equal(f.requests.at(-1).options.token, token);
  f.state.token = token; assert.equal((await f.prepare()).code, 'UPDATE_IN_PROGRESS');
});

test('a private game completes without creating a public post and releases the local workflow', async t => {
  const f = await fixture(t), first = await f.prepare(); await f.publish(first.id);
  f.state.completeStatus = 'restricted_skipped';
  const done = await f.complete(first.id);
  assert.equal(done.status, 'restricted_skipped'); assert.equal(done.post, null);
  assert.notEqual((await f.prepare()).id, first.id);
});

test('completion accepts exact legacy and AIWANNA community domains while lookalikes retain recovery',async t=>{
  const f=await fixture(t);
  for(const origin of ['https://www.ai-made.games','https://ai-made.games','https://www.aiwanna.games','https://aiwanna.games']){
    const update=await f.prepare(); await f.publish(update.id); f.state.postOrigin=origin;
    assert.equal((await f.complete(update.id)).status,'published',origin);
  }
  const pending=await f.prepare(); await f.publish(pending.id);
  for(const origin of ['https://aiwanna.games.evil.test','https://other.aiwanna.games','http://aiwanna.games','https://aiwanna.games:444']){
    f.state.postOrigin=origin;
    assert.equal((await f.complete(pending.id)).code,'PLATFORM_ERROR',origin);
    assert.equal((await f.prepare({updateId:pending.id})).id,pending.id);
  }
});

test('unsafe local update files and ancestor junctions are rejected before remote mutations', async t => {
  const f = await fixture(t), first = await f.prepare();
  const parent = join(f.directory, 'game-updates'), [origin] = await readdir(parent), dir = join(parent, origin), [filename] = await readdir(dir), path = join(dir, filename);
  const initial = await readFile(path, 'utf8');
  assert.ok(!initial.includes(f.state.token));
  const target = join(f.root, 'target'); await writeFile(target, initial); await rm(path); await link(target, path);
  assert.equal((await f.publish(first.id)).code, 'UPDATE_STORAGE_ERROR');
  assert.equal(await readFile(target, 'utf8'), initial); assert.equal(f.requests.length, 0);
  await rm(path); await writeFile(path, 'x'.repeat(5000));
  assert.equal((await f.prepare()).code, 'UPDATE_STORAGE_ERROR');
  const outside = join(f.root, 'outside'), alias = join(f.root, 'alias'); await mkdir(outside);
  if (!await testSymlink(t, outside, alias, process.platform === 'win32' ? 'junction' : 'dir')) return;
  f.platform.directory = alias;
  assert.equal((await f.prepare()).code, 'UPDATE_STORAGE_ERROR');
  assert.deepEqual(await readdir(outside), []);
});
