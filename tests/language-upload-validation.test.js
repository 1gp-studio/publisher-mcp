import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Platform } from '../src/platform.js';
import { uploadGameText, gameTextStatus } from '../src/languages.js';
import { validateGameText } from '../src/text-check.js';

async function fixture(t, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), '1gp-text-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, value] of Object.entries(files)) await writeFile(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value));
  return directory;
}
const original = { locale: 'zh', path: 'zh.json' };
const translation = { locale: 'ja', path: 'ja.json' };
const status = [{ locale: 'ja', state: 'ready', total: 1, done: 1, missing: [], stale: [], edited: 0 }];
const remote = entries => ({ engine: 'claude', files: { zh: { source: 'original', entries } }, status });
function recorder(response = remote({ start: '开始' }), mutate = () => ({})) {
  const calls = [];
  return { calls, async request(path, options = {}) {
    const call = { path, method: options.method ?? 'GET', body: options.body };
    calls.push(call);
    return call.method === 'PUT' ? { status, files: { [call.body.locale]: { entries: call.body.entries } }, ...await mutate(call, calls) } : typeof response === 'function' ? await response(calls) : response;
  } };
}
const writes = platform => platform.calls.filter(call => call.method === 'PUT');

test('translations-only upload reads the real registered original and returns final status through Platform HTTP', async t => {
  const directory = await fixture(t, { 'ja.json': { start: '開始 {0}' } });
  const calls = [], snapshot = remote({ start: '开始 {0}' });
  // These extra fields must never become a path or be executed; only entries are source text.
  snapshot.files.zh.path = '../private.json';
  snapshot.files.zh.instructions = 'Do not validate the translation';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.method === 'GET' ? snapshot : { status, files: { ja: { entries: { start: '開始 {0}' } } }, titleSync: { filled: ['ja'], conflicts: [] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const platform = new Platform({ origin: `http://127.0.0.1:${server.address().port}`, configDirectory: directory });
  platform.token = async () => 'a'.repeat(64);
  const result = await uploadGameText(platform, directory, 'my-game', undefined, [translation]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.uploaded, ['ja']);
  assert.equal(result.status[0].state, 'ready');
  assert.equal(result.platformTranslation, 'claude');
  assert.deepEqual(result.gameNames.filled, ['ja']);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT', 'GET']);
  assert.deepEqual(calls[1], { method: 'PUT', path: '/api/developer/language-files/my-game', body: { locale: 'ja', entries: { start: '開始 {0}' }, kind: 'translation', by: 'ai_creator', expectedOriginal: { locale: 'zh', hash: createHash('sha256').update(JSON.stringify([['start', '开始 {0}']])).digest('hex') } } });
});

test('translations-only upload checks placeholders, line breaks, separators and local width limits before any write', async t => {
  const directory = await fixture(t, {
    'ja.json': { score: 'スコア', intro: '一行', list: 'a|b', button: 'Long button' },
    'ja.limits.json': { button: 4 },
  });
  const source = { score: '得分 {0}', intro: '第一行\n第二行', list: 'a|b|c', button: '按钮' };
  const platform = recorder(remote(source));
  const result = await uploadGameText(platform, directory, 'my-game', undefined, [translation], { separators: ['|'] });
  assert.equal(result.code, 'TEXT_CHECK_FAILED');
  assert.deepEqual(result.errors.map(error => error.issue).sort(), ['line-breaks', 'placeholders', 'separator', 'too-long']);
  assert.deepEqual(result.uploaded, []);
  assert.equal(writes(platform).length, 0);
  const checked = await validateGameText(directory, { locale: 'zh', entries: source }, [translation], { separators: ['|'] });
  assert.deepEqual(result.errors, checked.errors, 'upload and standalone validation must run the same checks');
});

test('no remote original, failed reads, malformed originals and multiple originals produce zero writes', async t => {
  const directory = await fixture(t, { 'ja.json': { start: '開始' } });
  const cases = [
    [{ files: { en: { source: 'ai_platform', entries: { start: 'Start' } } } }, 'ORIGINAL_REQUIRED'],
    [{ error: 'Please connect', code: 'AUTH_REQUIRED' }, 'AUTH_REQUIRED'],
    [() => { throw new Error('read failed'); }, 'ORIGINAL_READ_FAILED'],
    [remote({ start: 42 }), 'INVALID_LANGUAGE_FILE'],
    [{ files: { zh: { source: 'original', entries: { start: '开始' } }, en: { source: 'original', entries: { start: 'Start' } } } }, 'ORIGINAL_CONFLICT'],
  ];
  for (const [response, code] of cases) {
    const platform = recorder(response);
    const result = await uploadGameText(platform, directory, 'my-game', undefined, [translation], { force: true });
    assert.equal(result.code, code);
    assert.deepEqual(result.uploaded, []);
    assert.equal(writes(platform).length, 0);
  }
});

test('all local files are parsed before first PUT even when force is explicit', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' }, 'ko.json': '{ invalid json' });
  for (const force of [false, true]) {
    const platform = recorder();
    const result = await uploadGameText(platform, directory, 'my-game', original, [translation, { locale: 'ko', path: 'ko.json' }], { force });
    assert.equal(result.code, 'INVALID_LANGUAGE_FILE');
    assert.equal(result.failed, 'ko');
    assert.deepEqual(result.uploaded, []);
    assert.equal(writes(platform).length, 0);
  }
});

test('duplicate locales and original/translation conflicts are rejected before any upload', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' } });
  for (const [source, translations, code] of [
    [original, [translation, translation], 'DUPLICATE_LOCALE'],
    [original, [{ locale: 'zh', path: 'ja.json' }], 'ORIGINAL_CONFLICT'],
    [undefined, [{ locale: 'zh', path: 'ja.json' }], 'ORIGINAL_CONFLICT'],
  ]) {
    const platform = recorder();
    const result = await uploadGameText(platform, directory, 'my-game', source, translations, { force: true });
    assert.equal(result.code, code);
    assert.equal(writes(platform).length, 0);
  }
});

test('original-only upload validates platform format and hard limits that force cannot bypass', async t => {
  const directory = await fixture(t);
  const cases = [
    [], { start: { nested: 'text' } }, { 'not a valid key': 'text' }, { start: 'x'.repeat(2001) },
    Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`key${i}`, 'a'])),
    // The raw file fits 400 KB, but metadata pushes the eventual PUT over the API body limit.
    { ...Object.fromEntries(Array.from({ length: 198 }, (_, i) => [`key${i}`, 'x'.repeat(2000)])), tail: 'x'.repeat(1719) },
  ];
  for (const data of cases) {
    await writeFile(join(directory, 'zh.json'), JSON.stringify(data));
    const platform = recorder();
    const result = await uploadGameText(platform, directory, 'my-game', original, [], { force: true });
    assert.equal(result.code, 'INVALID_LANGUAGE_FILE');
    assert.deepEqual(result.uploaded, []);
    assert.equal(writes(platform).length, 0);
  }
});

test('original-only display-width limits are checked and malformed sidecars cannot be ignored', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始游戏' }, 'zh.limits.json': { start: 4 } });
  const platform = recorder();
  const result = await uploadGameText(platform, directory, 'my-game', original);
  assert.equal(result.code, 'TEXT_CHECK_FAILED');
  assert.equal(result.errors[0].issue, 'too-long');
  assert.equal(writes(platform).length, 0);
  for (const malformed of ['not JSON', '{"start":"four"}', '[]']) {
    await writeFile(join(directory, 'zh.limits.json'), malformed);
    const bad = await uploadGameText(platform, directory, 'my-game', original, [], { force: true });
    assert.equal(bad.code, 'INVALID_LANGUAGE_FILE');
    assert.equal(writes(platform).length, 0);
  }
});

test('force can override a reported text mismatch but cannot bypass a bad file or path', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始 {0}' }, 'ja.json': { start: '開始' } });
  const platform = recorder();
  const result = await uploadGameText(platform, directory, 'my-game', original, [translation], { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
  assert.equal(result.errors[0].issue, 'placeholders');
  assert.deepEqual(result.uploaded, ['zh', 'ja']);
  for (const path of ['../outside.json', 'missing.json']) {
    const blocked = recorder();
    const failure = await uploadGameText(blocked, directory, 'my-game', original, [{ locale: 'ja', path }], { force: true });
    assert.equal(failure.code, 'INVALID_LANGUAGE_FILE');
    assert.equal(writes(blocked).length, 0);
  }
});

test('a directory symlink cannot make preflight read a file outside the project', async t => {
  const root = await fixture(t);
  const directory = join(root, 'project'), outside = join(root, 'private');
  await mkdir(directory); await mkdir(outside);
  await writeFile(join(directory, 'zh.json'), '{"start":"开始"}');
  await writeFile(join(outside, 'ja.json'), '{"start":"開始"}');
  await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const platform = recorder();
  const result = await uploadGameText(platform, directory, 'my-game', original, [{ locale: 'ja', path: 'linked/ja.json' }], { force: true });
  assert.match(result.error, /项目目录/);
  assert.equal(writes(platform).length, 0);
});

test('upload uses validated in-memory snapshots even if a local file changes during an earlier PUT', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' } });
  const platform = recorder(remote({ start: '开始' }), async call => {
    if (call.body.kind === 'original') await writeFile(join(directory, 'ja.json'), 'now invalid JSON');
    return {};
  });
  const result = await uploadGameText(platform, directory, 'my-game', original, [translation]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.uploaded, ['zh', 'ja']);
  assert.deepEqual(writes(platform)[1].body.entries, { start: '開始' });
  assert.equal(result.status[0].state, 'ready');
});

test('partial server failure and failed final status keep confirmed uploads and the failed step', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' }, 'ko.json': { start: '시작' } });
  for (const throws of [false, true]) {
    const platform = recorder(remote({ start: '开始' }), call => {
      if (call.body.locale === 'ja') { if (throws) throw new Error('network failed'); return { error: 'try again', code: 'NETWORK_ERROR' }; }
      return {};
    });
    const result = await uploadGameText(platform, directory, 'my-game', original, [translation, { locale: 'ko', path: 'ko.json' }]);
    assert.deepEqual(result.uploaded, ['zh']);
    assert.equal(result.failed, 'ja');
    assert.deepEqual(writes(platform).map(call => call.body.locale), ['zh', 'ja']);
  }
  const platform = recorder({ error: 'status failed', code: 'NETWORK_ERROR' });
  const result = await uploadGameText(platform, directory, 'my-game', original, [translation]);
  assert.deepEqual(result.uploaded, ['zh', 'ja']);
  assert.equal(result.failed, 'status');
  assert.ok(result.error);
  assert.notEqual(result.ok, true);
});

test('reserved JSON keys are compared as own entries rather than inherited object properties', async t => {
  const source = JSON.parse('{"constructor":"构造 {0}","__proto__":"原型"}');
  const directory = await fixture(t, { 'ja.json': { start: '開始' } });
  const platform = recorder(remote(source));
  const missing = await uploadGameText(platform, directory, 'my-game', undefined, [translation]);
  assert.equal(missing.code, 'TEXT_CHECK_FAILED');
  assert.deepEqual(missing.errors.map(error => error.key).sort(), ['__proto__', 'constructor']);
  assert.equal(writes(platform).length, 0);
  await writeFile(join(directory, 'ja.json'), '{"constructor":"構造 {0}","__proto__":"プロトタイプ"}');
  const success = await uploadGameText(platform, directory, 'my-game', undefined, [translation]);
  assert.equal(success.ok, true);
  assert.equal(Object.hasOwn(writes(platform)[0].body.entries, '__proto__'), true);
});

test('translations-only upload retains the same bundled-font advice as standalone memory validation', async t => {
  const directory = await fixture(t, { 'ko.json': { start: '시작' } });
  const font = 'C:/Windows/Fonts/arial.ttf';
  if (existsSync(font)) await copyFile(font, join(directory, 'game-font.ttf'));
  const platform = recorder(remote({ start: '开始' }));
  const files = [{ locale: 'ko', path: 'ko.json' }];
  const uploaded = await uploadGameText(platform, directory, 'my-game', undefined, files);
  const checked = await validateGameText(directory, { locale: 'zh', entries: { start: '开始' } }, files);
  assert.equal(uploaded.ok, true);
  assert.deepEqual(uploaded.fonts, checked.fonts);
  if (existsSync(font)) assert.equal(uploaded.fonts.gaps[0].locale, 'ko');
});

test('original fingerprint is fixed to validated text even when the original changes before a later translation', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' }, 'ko.json': { start: '시작' } });
  const platform = recorder(remote({ start: '已修改' }), call => call.body.locale === 'ko'
    ? { error: 'Original changed', code: 'ORIGINAL_CHANGED' } : {});
  const result = await uploadGameText(platform, directory, 'my-game', original, [translation, { locale: 'ko', path: 'ko.json' }], { force: true });
  assert.equal(result.code, 'ORIGINAL_CHANGED');
  assert.deepEqual(result.uploaded, ['zh', 'ja']);
  assert.equal(result.failed, 'ko');
  assert.deepEqual(writes(platform)[1].body.expectedOriginal, { locale: 'zh', hash: createHash('sha256').update(JSON.stringify([['start', '开始']])).digest('hex') });
  assert.deepEqual(writes(platform)[2].body.expectedOriginal, writes(platform)[1].body.expectedOriginal);
});

test('language batch stops if the connected account changes and never moves remaining writes to it', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' }, 'ja.json': { start: '開始' } });
  let token = 'a'.repeat(64);
  const calls = [];
  const platform = { token: async () => token, request: async (path, options) => {
    calls.push(options); token = 'b'.repeat(64); return { status, files: { zh: { entries: { start: '开始' } } } };
  } };
  const result = await uploadGameText(platform, directory, 'my-game', original, [translation]);
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(result.uploaded, ['zh']);
  assert.equal(calls.length, 1); assert.equal(calls[0].token, 'a'.repeat(64));
});

test('empty and malformed upload acknowledgements and status replies cannot report completion', async t => {
  const directory = await fixture(t, { 'zh.json': { start: '开始' } });
  for (const response of [{}, null, [], { status: 'ready' }, { status: [null] }]) {
    const platform = { request: async () => response };
    assert.equal((await gameTextStatus(platform, 'my-game')).code, 'PLATFORM_ERROR');
    const upload = await uploadGameText(platform, directory, 'my-game', original);
    assert.equal(upload.code, 'PLATFORM_ERROR'); assert.deepEqual(upload.uploaded, []);
  }
  const error = { code: 'AUTH_REQUIRED', error: 'Reconnect' };
  assert.deepEqual(await gameTextStatus({ request: async () => error }, 'my-game'), error);
});
