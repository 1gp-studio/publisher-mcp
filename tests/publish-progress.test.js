import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPublishJob, publishWithTracking, waitForPublish, withMaterialNextSteps } from '../src/publish-progress.js';
import { testSymlink } from './helpers/symlink.js';
import { updateApprovalGuidance, updateHistoryGuidance } from '../src/update-approval-guidance.js';

const buildA = '11111111-1111-4111-8111-111111111111';
const buildB = '22222222-2222-4222-8222-222222222222';
const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const digest = text => createHash('sha256').update(text).digest('hex');
const fileFor = (platform, token = tokenA) => join(platform.directory, 'publish-jobs', digest(platform.origin), `${digest(token)}.json`);

function fakeClock() {
  let time = 0, serial = 0;
  const timers = new Map(), sleeps = [];
  const advance = milliseconds => {
    const target = time + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].callback();
    }
    time = target;
  };
  return { now: () => time, advance, sleeps,
    sleep: async milliseconds => { sleeps.push(milliseconds); advance(milliseconds); },
    setTimeout: (callback, milliseconds) => { const id = ++serial; timers.set(id, { callback, at: time + milliseconds }); return id; },
    clearTimeout: id => timers.delete(id),
    get timers() { return timers.size; },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), '1gp-publish-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = fakeClock(), calls = [];
  let token = tokenA, response = () => ({ id: buildA, state: 'building' });
  const platform = {
    directory, origin: 'https://platform.example', token: async () => token,
    request: async (path, options) => {
      calls.push({ path, options, at: clock.now() });
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.match(path, /^\/api\/publish\/[a-f0-9-]{36}$/i);
      return response(path, options);
    },
  };
  return { platform, clock, calls, setToken: value => { token = value; }, respond: value => { response = typeof value === 'function' ? value : () => value; } };
}

test('submitted jobs are private atomic records scoped by platform and token hash, with no bearer token stored', async t => {
  const { platform } = await fixture(t);
  const saved = await recordPublishJob(platform, { buildId: buildA, gameSlug: 'my-game', channel: 'github' });
  assert.deepEqual(saved, { recorded: true, buildId: buildA });
  const file = fileFor(platform), text = await readFile(file, 'utf8'), job = JSON.parse(text);
  assert.equal(text.includes(tokenA), false);
  assert.equal(job.buildId, buildA); assert.equal(job.gameSlug, 'my-game'); assert.equal(job.channel, 'github');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const results = await Promise.all(Array.from({ length: 6 }, (_, at) => recordPublishJob(platform, { buildId: at % 2 ? buildA : buildB })));
  assert.ok(results.every(result => result.recorded));
  assert.ok([buildA, buildB].includes(JSON.parse(await readFile(file, 'utf8')).buildId));
  assert.deepEqual(await readdir(join(platform.directory, 'publish-jobs', digest(platform.origin))), [`${digest(tokenA)}.json`]);
});

test('omitting buildId resumes the last job only for the same platform and connected account', async t => {
  const f = await fixture(t);
  await recordPublishJob(f.platform, { buildId: buildA, gameSlug: 'original-game' });
  f.respond({ id: buildA, state: 'ready', games: { slug: 'actual-game' }, release_version: '1.2.3' });
  f.setToken(tokenB);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'NO_PUBLISH_JOB');
  f.setToken(tokenA);
  assert.equal((await waitForPublish({ ...f.platform, origin: 'https://other.example' }, {}, f.clock)).code, 'NO_PUBLISH_JOB');
  assert.equal(f.calls.length, 0);
  const result = await waitForPublish(f.platform, {}, f.clock);
  assert.equal(result.resumed, true); assert.equal(result.pending, false); assert.equal(result.terminal, true);
  assert.equal(result.gameUrl, 'https://platform.example/games/actual-game'); assert.equal(result.release_version, '1.2.3');
  assert.equal(result.workflowComplete, false); assert.equal(result.materialStatus, 'needs_verification');
  assert.equal(result.gameSlug, 'actual-game'); assert.match(result.nextSteps.join('\n'), /get_game_materials\(\{gameSlug:"actual-game"\}\)/);
  assert.equal(f.calls[0].options.token, tokenA);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).state, 'ready', 'Terminal records remain recoverable after a lost tool response');
});

test('waiting follows queued/building to ready, queries at least ten seconds apart, and never republishes', async t => {
  const f = await fixture(t), states = ['queued', 'building', 'ready'];
  await recordPublishJob(f.platform, { buildId: buildA, gameSlug: 'my-game', channel: 'local' });
  f.respond(() => ({ id: buildA, state: states.shift(), progress: { stage: 'deploy' } }));
  const result = await waitForPublish(f.platform, {}, f.clock);
  assert.equal(result.state, 'ready'); assert.equal(result.gameUrl, 'https://platform.example/games/my-game');
  assert.equal(result.terminal, true); assert.equal(result.pending, false);
  assert.deepEqual(f.calls.map(call => call.at), [0, 10000, 20000]);
  assert.deepEqual(f.calls.map(call => call.options.timeoutMs), [45000, 35000, 25000]);
  assert.equal(f.clock.timers, 0);
});

test('failed is terminal, keeps the platform explanation, and never returns a game URL', async t => {
  const f = await fixture(t);
  f.respond({ id: buildA, state: 'failed', message: 'Build exited with code 1', gameUrl: 'https://unverified.example', games: { slug: 'my-game' } });
  const result = await waitForPublish(f.platform, { buildId: buildA }, f.clock);
  assert.equal(result.state, 'failed'); assert.equal(result.terminal, true); assert.equal(result.pending, false);
  assert.equal(result.message, 'Build exited with code 1'); assert.equal(result.gameUrl, undefined);
  assert.equal(result.nextSteps, undefined); assert.equal(result.materialStatus, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.clock.now(), 0);
});

test('the 45-second wait returns a recoverable pending job without a premature URL', async t => {
  const f = await fixture(t);
  f.respond({ id: buildA, state: 'building', message: 'Still building', gameUrl: 'https://not-ready.example' });
  const result = await waitForPublish(f.platform, { buildId: buildA }, f.clock);
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(result.state, 'building'); assert.equal(result.buildId, buildA);
  assert.equal(result.pending, true); assert.equal(result.terminal, false); assert.equal(result.gameUrl, undefined);
  assert.deepEqual(f.calls.map(call => call.at), [0, 10000, 20000, 30000, 40000]);
  assert.equal(f.clock.now(), 45000); assert.match(result.nextStep, /不要重新/);
  f.respond({ id: buildA, state: 'ready', games: { slug: 'done' } });
  assert.equal((await waitForPublish(f.platform, { waitSeconds: 0 }, f.clock)).gameUrl, 'https://platform.example/games/done');
});

test('request time consumes the wait budget and zero seconds performs just one bounded query', async t => {
  const f = await fixture(t);
  f.respond(() => { f.clock.advance(4000); return { id: buildA, state: 'building' }; });
  const result = await waitForPublish(f.platform, { buildId: buildA, waitSeconds: 25 }, f.clock);
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(f.clock.now(), 25000);
  assert.deepEqual(f.calls.map(call => call.at), [0, 14000]);
  assert.deepEqual(f.calls.map(call => call.options.timeoutMs), [25000, 11000]);
  f.respond({ id: buildA, state: 'building' });
  const once = await waitForPublish(f.platform, { waitSeconds: 0 }, f.clock);
  assert.equal(once.pending, true); assert.equal(once.code, undefined); assert.equal(once.gameUrl, undefined);
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].options.timeoutMs, 10000);
});

test('a hung platform request is aborted at the total deadline even if its implementation ignores timeoutMs', async t => {
  const f = await fixture(t);
  let start;
  const requested = new Promise(resolve => { start = resolve; });
  f.respond(() => { start(); return new Promise(() => {}); });
  const waiting = waitForPublish(f.platform, { buildId: buildA, waitSeconds: 12 }, f.clock);
  await requested; f.clock.advance(12000);
  const result = await waiting;
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(result.pending, true); assert.equal(result.buildId, buildA);
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.clock.timers, 0);
  assert.equal(JSON.parse(await readFile(fileFor(f.platform), 'utf8')).buildId, buildA);
});

test('network failures and API errors retain the job and explicitly ask for continued status checks', async t => {
  const f = await fixture(t);
  for (const response of [() => { throw new Error('offline'); }, { code: 'NETWORK_ERROR', error: 'offline' }, { code: 'AUTH_REQUIRED', error: 'Reconnect' }, { error: '暂时无法查询。' }]) {
    f.respond(response);
    const result = await waitForPublish(f.platform, { buildId: buildA }, f.clock);
    assert.equal(result.pending, true); assert.equal(result.terminal, false); assert.equal(result.buildId, buildA);
    assert.ok(result.error); assert.match(result.nextStep, /继续查询/); assert.equal(result.gameUrl, undefined);
    assert.equal(JSON.parse(await readFile(fileFor(f.platform), 'utf8')).buildId, buildA);
  }
  assert.equal(f.calls.length, 4, 'Errors are returned rather than triggering another publish or automatic retry');
  f.respond({ id: buildA, state: 'ready', games: { slug: 'recovered' } });
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).state, 'ready');
});

test('a credential change during a query discards its result and cannot resume that job under the new account', async t => {
  const f = await fixture(t);
  f.respond(() => { f.setToken(tokenB); return { id: buildA, state: 'ready', games: { slug: 'old-account' } }; });
  const result = await waitForPublish(f.platform, { buildId: buildA }, f.clock);
  assert.equal(result.code, 'ACCOUNT_CHANGED'); assert.equal(result.gameUrl, undefined); assert.equal(result.pending, true);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'NO_PUBLISH_JOB');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.token, tokenA);
});

for (const channel of ['local', 'docker', 'github']) test(`${channel} submission uses one credential and a late account switch never replaces the new account's recovery record`, async t => {
  const f = await fixture(t);
  f.setToken(tokenB);
  await recordPublishJob(f.platform, { buildId: buildB, gameSlug: 'new-account-game' });
  f.setToken(tokenA);
  const calls = [], endpoint = channel === 'github' ? '/api/games/original-game/build' : '/api/publish';
  const platform = { ...f.platform, request: async (path, options) => {
    calls.push({ path, ...options });
    // Change credentials during a pre-submit author read, as well as before the POST returns.
    f.setToken(tokenB);
    return options.body ? { id: buildA, state: 'queued', message: 'Submitted' } : { ready: true };
  } };
  const result = await publishWithTracking(platform, { channel, gameSlug: 'original-game' }, async client => {
    await client.request('/api/author/preflight');
    assert.equal(await client.token(), tokenA);
    return client.request(endpoint, { body: { source: channel } });
  });
  assert.deepEqual(calls.map(call => call.token), [tokenA, tokenA]);
  assert.equal(calls.filter(call => call.body).length, 1, 'an account change must never replay the submission');
  assert.equal(result.id, buildA); assert.equal(result.state, 'queued'); assert.equal(result.message, 'Submitted');
  assert.equal(result.error, undefined, 'a recovery warning must not claim the submitted publication failed');
  assert.equal(result.tracking.recorded, false); assert.equal(result.tracking.code, 'ACCOUNT_CHANGED');
  assert.equal(result.tracking.buildId, buildA);
  assert.equal(JSON.parse(await readFile(fileFor(f.platform, tokenB), 'utf8')).buildId, buildB);
  await assert.rejects(readFile(fileFor(f.platform, tokenA)), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(result).includes(tokenA) && !JSON.stringify(result).includes(tokenB));
});

test('tracked submissions preserve successful and failed responses, record only known builds and require authentication', async t => {
  const f = await fixture(t);
  let submissions = 0;
  f.setToken(null);
  assert.equal((await publishWithTracking(f.platform, { channel: 'local' }, async () => { submissions++; })).code, 'AUTH_REQUIRED');
  assert.equal(submissions, 0);
  f.setToken(tokenA);
  const ready = await publishWithTracking(f.platform, { channel: 'local', gameSlug: 'my-game' }, async () => ({ id: buildA, state: 'ready', path: '/games/my-game' }));
  assert.equal(ready.tracking.recorded, true); assert.equal(ready.gameUrl, 'https://platform.example/games/my-game');
  assert.equal(ready.workflowComplete, false); assert.match(ready.nextSteps.join('\n'), /set_game_media/);
  const queued = await publishWithTracking(f.platform, { channel: 'local', gameSlug: 'my-game' }, async () => ({ id: buildA, state: 'queued', path: '/games/my-game' }));
  assert.equal(queued.state, 'queued'); assert.equal(queued.gameUrl, 'https://platform.example/games/my-game', 'the allocated page URL is retained for existing submission clients');
  assert.equal(queued.nextSteps, undefined); assert.equal(queued.materialStatus, undefined);
  const failed = { code: 'NETWORK_ERROR', error: 'Unknown submission outcome' };
  assert.deepEqual(await publishWithTracking(f.platform, { channel: 'docker' }, async () => failed), failed);
  assert.equal(JSON.parse(await readFile(fileFor(f.platform), 'utf8')).buildId, buildA);
  const stale = await recordPublishJob(f.platform, { buildId: buildB }, tokenB);
  assert.equal(stale.code, 'ACCOUNT_CHANGED'); assert.equal(stale.recorded, false);
  assert.equal(JSON.parse(await readFile(fileFor(f.platform), 'utf8')).buildId, buildA);
});

test('ready follow-up covers kit metadata, reviewed media and verification without inventing a game or enabling features',()=>{
  const ready=withMaterialNextSteps({state:'ready',path:'/games/new-game'});
  assert.equal(ready.gameSlug,'new-game'); assert.equal(ready.workflowComplete,false);
  for(const expected of ['1gp-kit/game.json','get_game_materials','set_game_details(fillMissing=true)','set_game_media','保留已有','作者关闭预览','同一 update_id','纯元数据或媒体补充无需再次部署','complete_game_update','未选择的可选功能不自动开启']) assert.ok(ready.nextSteps.join('\n').includes(expected),expected);
  assert.ok(ready.nextSteps.join('\n').includes(updateApprovalGuidance.zh));
  assert.ok(ready.nextSteps.join('\n').includes(updateHistoryGuidance.zh));
  const unknown=withMaterialNextSteps({state:'ready',path:'/games/../other'});
  assert.equal(unknown.gameSlug,undefined); assert.match(unknown.nextSteps.join('\n'),/不编造标识/);
  for(const unchanged of [{state:'building'},{state:'failed'},{state:'ready',error:'Unverified'}]) assert.equal(withMaterialNextSteps(unchanged),unchanged);
});

test('invalid options, unknown states and mismatched response IDs never imply a successful publication', async t => {
  const f = await fixture(t);
  for (const options of [{ buildId: '../other' }, { waitSeconds: -1 }, { waitSeconds: 46 }, { waitSeconds: NaN }, { pollIntervalSeconds: 1 }, { pollIntervalSeconds: Infinity }]) assert.ok((await waitForPublish(f.platform, options, f.clock)).error);
  assert.equal(f.calls.length, 0);
  f.setToken(null); assert.equal((await waitForPublish(f.platform, { buildId: buildA }, f.clock)).code, 'AUTH_REQUIRED'); f.setToken(tokenA);
  for (const response of [null, [], { state: 'deploying' }, { id: buildB, state: 'ready' }]) {
    f.respond(response);
    const result = await waitForPublish(f.platform, { buildId: buildA }, f.clock);
    assert.equal(result.code, 'PLATFORM_ERROR'); assert.equal(result.pending, true); assert.equal(result.gameUrl, undefined);
  }
});

test('corrupt, oversized and wrong-account records are not used to query arbitrary builds', async t => {
  const f = await fixture(t);
  await recordPublishJob(f.platform, { buildId: buildA });
  const file = fileFor(f.platform), original = JSON.parse(await readFile(file, 'utf8'));
  for (const contents of ['{', '{}', 'x'.repeat(8193), JSON.stringify({ ...original, accountHash: digest(tokenB) }), JSON.stringify({ ...original, buildId: '../secret' })]) {
    await writeFile(file, contents);
    assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'PUBLISH_JOB_STORAGE_ERROR');
  }
  assert.equal(f.calls.length, 0);
  f.respond({ id: buildB, state: 'ready' });
  const explicit = await waitForPublish(f.platform, { buildId: buildB }, f.clock);
  assert.equal(explicit.state, 'ready'); assert.equal(JSON.parse(await readFile(file, 'utf8')).buildId, buildB);
});

test('publish record file symlinks cannot read or overwrite a different file', async t => {
  const f = await fixture(t);
  await recordPublishJob(f.platform, { buildId: buildA });
  const file = fileFor(f.platform), target = join(f.platform.directory, 'target.json');
  await writeFile(target, await readFile(file)); await rm(file);
  if (!await testSymlink(t, target, file)) return;
  assert.equal((await recordPublishJob(f.platform, { buildId: buildB })).recorded, false);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'PUBLISH_JOB_STORAGE_ERROR');
  assert.equal(JSON.parse(await readFile(target, 'utf8')).buildId, buildA); assert.equal(f.calls.length, 0);
});

test('publish record directories reject symlinks and junctions without creating files in their target', async t => {
  const f = await fixture(t), target = join(f.platform.directory, 'elsewhere');
  await mkdir(target);
  if (!await testSymlink(t, target, join(f.platform.directory, 'publish-jobs'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.equal((await recordPublishJob(f.platform, { buildId: buildA })).recorded, false);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'PUBLISH_JOB_STORAGE_ERROR');
  assert.deepEqual(await readdir(target), []); assert.equal(f.calls.length, 0);
});

test('hard-linked records are rejected and a storage error never claims the submitted build failed', async t => {
  const f = await fixture(t);
  await recordPublishJob(f.platform, { buildId: buildA });
  const file = fileFor(f.platform), target = join(f.platform.directory, 'linked.json');
  await link(file, target);
  const saved = await recordPublishJob(f.platform, { buildId: buildB });
  assert.equal(saved.recorded, false); assert.equal(saved.buildId, buildB); assert.equal(saved.code, 'PUBLISH_JOB_STORAGE_ERROR');
  assert.equal(saved.state, undefined); assert.equal(JSON.parse(await readFile(target, 'utf8')).buildId, buildA);
  assert.equal((await waitForPublish(f.platform, {}, f.clock)).code, 'PUBLISH_JOB_STORAGE_ERROR');
  assert.equal(f.calls.length, 0);
});
