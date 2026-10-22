import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGameTextSource, configureGameTextSource, approveGameTextCandidates } from '../src/text-source.js';
const key = 'p.' + 'a'.repeat(64), fingerprint = 'b'.repeat(64);
const integration = { state: 'not_verified', message: 'SDK/Godot rendering still needs verification' };
function fixture(config = null) {
  const calls = [], state = { config, token: 'owner-a', fail: null };
  const platform = { token: async () => state.token, request: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (state.fail?.(options)) return { error: 'Conflict', code: 'SOURCE_CHANGED' };
    if (options.method === 'PUT') state.config = { ...options.body, revision: (state.config?.revision ?? 0) + 1 };
    return { config: state.config, engine: null, status: [], integration };
  } };
  return { calls, state, platform };
}
const options = { use: 'phrases', enabled: true, locale: 'zh', files: ['index.html', 'assets/game.js'] };
test('configuration uses the current revision once, preserves exclusions and reports the bounded scan', async () => {
  const f = fixture({ ...options, excluded: [key], revision: 7 });
  const result = await configureGameTextSource(f.platform, 'my-game', options);
  assert.deepEqual(f.calls.map(call => call.method ?? 'GET'), ['GET', 'PUT', 'POST']);
  assert.ok(f.calls.every(call => call.path === '/api/developer/text-source/my-game?use=phrases' && call.token === 'owner-a'));
  assert.deepEqual(f.calls[1].body, { enabled: true, locale: 'zh', files: options.files, excluded: [key], expectedRevision: 7 });
  assert.deepEqual(f.calls[2].body, { action: 'scan' });
  assert.equal(result.config.revision, 8); assert.equal(result.engine, null); assert.equal(result.integration.state, 'not_verified');
});
test('new configuration starts at revision zero; no-scan and disabled configuration do not scan', async () => {
  for (const extra of [{ scan: false }, { enabled: false }]) {
    const f = fixture(), result = await configureGameTextSource(f.platform, 'my-game', { ...options, ...extra });
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].body.expectedRevision, 0); assert.equal(result.config.enabled, extra.enabled ?? true);
  }
});
test('failed reads, CAS conflicts and unconfirmed writes never proceed to scanning or retry', async () => {
  for (const at of ['GET', 'PUT']) {
    const f = fixture(); f.state.fail = options => (options.method ?? 'GET') === at;
    assert.equal((await configureGameTextSource(f.platform, 'my-game', options)).code, 'SOURCE_CHANGED');
    assert.equal(f.calls.length, at === 'GET' ? 1 : 2);
  }
  const f = fixture(); f.platform.request = async (path, options = {}) => { f.calls.push({ path, ...options }); return { config: null, engine: null, status: [], integration }; };
  assert.equal((await configureGameTextSource(f.platform, 'my-game', options)).code, 'TEXT_SOURCE_UNCONFIRMED');
  assert.equal(f.calls.length, 2);
});
test('scan failure reports saved configuration without claiming successful scanning or translation', async () => {
  const f = fixture(); f.state.fail = options => options.method === 'POST';
  const result = await configureGameTextSource(f.platform, 'my-game', options);
  assert.equal(result.code, 'SOURCE_CHANGED'); assert.equal(result.configurationSaved, true); assert.equal(result.config.enabled, true); assert.equal(result.integration.state, 'not_verified');
});
test('a successful HTTP response still reports a failed scan and preserves provider-off guidance', async () => {
  const f = fixture(), request = f.platform.request;
  f.platform.request = async (path, options = {}) => {
    const data = await request(path, options);
    if (options.method === 'POST') return { ...data, config: { ...data.config, last_result: 'failed', last_error: 'Source unavailable' }, scan: { scanned: 1, synced: 0, review: 0, failed: 1, superseded: 0, lease_token: 'PRIVATE' } };
    return data;
  };
  const result = await configureGameTextSource(f.platform, 'my-game', options);
  assert.equal(result.code, 'TEXT_SOURCE_SCAN_FAILED'); assert.equal(result.configurationSaved, true);
  assert.equal(result.scan.failed, 1); assert.equal(result.config.last_error, 'Source unavailable');
  assert.match(result.translationNotice, /宿主 AI/); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('snapshots omit private lease fields and malformed or older servers stay unavailable', async () => {
  const f = fixture({ ...options, revision: 1, lease_token: 'private', source_fingerprint: fingerprint });
  const result = await getGameTextSource(f.platform, 'my-game', 'phrases');
  assert.equal(result.config.source_fingerprint, fingerprint); assert.equal(Object.hasOwn(result.config, 'lease_token'), false);
  for (const response of [null, {}, { config: null }, { config: {}, engine: null, status: [], integration }]) {
    f.platform.request = async () => response;
    assert.equal((await getGameTextSource(f.platform, 'my-game')).code, 'TEXT_SOURCE_UNAVAILABLE');
  }
  f.platform.request = async () => { throw new Error('private transport details'); };
  assert.doesNotMatch(JSON.stringify(await getGameTextSource(f.platform, 'my-game')), /private transport/);
});

test('a superseded scan reports a conflict even if the latest config shows an earlier success', async () => {
  const f = fixture(), request = f.platform.request;
  f.platform.request = async (path, options = {}) => {
    const data = await request(path, options);
    return options.method === 'POST' ? { ...data, config: { ...data.config, last_result: 'success' },
      scan: { scanned: 1, synced: 0, review: 0, failed: 0, superseded: 1, queued: false, status: 'partial' } } : data;
  };
  const result = await configureGameTextSource(f.platform, 'my-game', options);
  assert.equal(result.code, 'SOURCE_CHANGED'); assert.equal(result.configurationSaved, true);
  assert.match(result.error, /未确认应用/); assert.equal(result.scan.superseded, 1);
  assert.equal(result.scan.synced, 0); assert.equal(result.config.last_result, 'success');
  assert.deepEqual(f.calls.map(call => call.method ?? 'GET'), ['GET', 'PUT', 'POST'], 'Do not retry or overwrite the concurrent change');
});

test('a scan waiting for its lease remains queued instead of claiming text was synchronized', async () => {
  const f = fixture(), request = f.platform.request;
  f.platform.request = async (path, options = {}) => {
    const data = await request(path, options);
    return options.method === 'POST' ? { ...data, config: { ...data.config, last_result: 'pending' },
      scan: { scanned: 0, synced: 0, review: 0, failed: 0, superseded: 0, queued: true, status: 'complete', lease_token: 'PRIVATE' } } : data;
  };
  const result = await configureGameTextSource(f.platform, 'my-game', options);
  assert.equal(result.scan.queued, true); assert.equal(result.scan.scanned, 0); assert.equal(result.scan.synced, 0);
  assert.equal(result.config.last_result, 'pending'); assert.equal(result.integration.state, 'not_verified');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('approval uses only reviewed keys and rejects changed fingerprints or revisions', async () => {
  const f = fixture({ ...options, revision: 2, source_fingerprint: fingerprint, pending_entries: { [key]: 'Play' } });
  const approval = { keys: [key], expectedRevision: 2, expectedFingerprint: fingerprint };
  await approveGameTextCandidates(f.platform, 'my-game', approval);
  assert.deepEqual(f.calls.at(-1).body, { action: 'approve', ...approval });
  for (const patch of [{ expectedRevision: 1 }, { expectedFingerprint: 'c'.repeat(64) }]) {
    f.calls.length = 0;
    assert.equal((await approveGameTextCandidates(f.platform, 'my-game', { ...approval, ...patch })).code, 'SOURCE_CHANGED');
    assert.equal(f.calls.length, 1);
  }
});
test('account changes never send the next mutation under another account', async () => {
  for (const at of ['GET', 'PUT']) {
    const f = fixture(), request = f.platform.request;
    f.platform.request = async (path, options = {}) => { const data = await request(path, options); if ((options.method ?? 'GET') === at) f.state.token = 'owner-b'; return data; };
    assert.equal((await configureGameTextSource(f.platform, 'my-game', options)).code, 'ACCOUNT_CHANGED');
    assert.equal(f.calls.length, at === 'GET' ? 1 : 2); assert.ok(f.calls.every(call => call.token === 'owner-a'));
  }
});
test('invalid paths, modes and approval inputs fail before any network call', async () => {
  const f = fixture();
  for (const extra of [{ files: ['../x.js'] }, { files: ['https://other.example/game.js'] }, { files: ['a.js?token=secret'] },
    { files: ['a.js', 'a.js'] }, { use: 'keys', files: ['a.json', 'b.json'] }, { use: 'keys', files: ['a.js'] }, { use: 'keys', files: ['a.json'], excluded: [key] }, { locale: 'ru' }, { use: 'other' }])
    await assert.rejects(configureGameTextSource(f.platform, 'my-game', { ...options, ...extra }));
  await assert.rejects(approveGameTextCandidates(f.platform, 'my-game', { keys: [key], expectedRevision: 1, expectedFingerprint: '' }));
  await assert.rejects(getGameTextSource(f.platform, '../game'));
  assert.equal(f.calls.length, 0);
});
