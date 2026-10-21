import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGame } from '../src/prepare-game.js';
import { testSymlink } from './helpers/symlink.js';

const choices = { multilingual: null, cloudSaves: null, leaderboards: null };
const disabled = { cloudSaves: { enabled: false, schemaVersion: 1 }, leaderboards: [] };
const board = { id: '12345678-1234-4123-8123-123456789abc', key: 'score', enabled: true };
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'prepare-game-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'game'), directory = join(base, 'config');
  await mkdir(project); await mkdir(directory);
  await writeFile(join(project, 'index.html'), '<!doctype html><title>Test game</title>');
  const calls = [];
  const state = { token: 'a'.repeat(64), matches: [{ slug: 'test-game', title: 'Test game' }],
    context: { source: 'local', gameSlug: 'test-game', suggested: { patch: '1.0.1' } }, integrations: disabled };
  const platform = { origin: 'https://platform.example', directory, token: async () => state.token,
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/developer/games/match') return state.matchError ?? { matches: state.matches };
      if (path.startsWith('/api/publish/releases/context?')) return state.context;
      if (path === '/api/developer/game-integrations/test-game') {
        if (state.networkError) throw new Error('Network unavailable');
        return state.integrations;
      }
      throw new Error(`Unexpected request: ${path}`);
    } };
  const file = async () => join(platform.directory, `options-${createHash('sha256').update(JSON.stringify([platform.origin, state.token, await realpath(project)])).digest('hex')}.json`);
  return { base, project, directory, platform, state, calls, file };
}

test('preparation finds the game once and includes channel, inspection, language and integration checks', async t => {
  const f = await fixture(t), result = await prepareGame(f.platform, f.project);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/developer/games/match', '/api/publish/releases/context?slug=test-game', '/api/developer/game-integrations/test-game']);
  assert.equal(result.channel, 'local');
  assert.equal(result.inspection.ready, true);
  assert.equal(result.languageCheck.multilingual, false);
  assert.deepEqual(result.integrations, disabled);
  assert.deepEqual(result.features, choices);
  assert.deepEqual(result.decisions, ['multilingual', 'cloudSaves', 'leaderboards']);
  assert.ok(!JSON.stringify(result).includes(f.state.token));
  assert.deepEqual(await readdir(f.directory), []);
});

test('existing capabilities are retained without asking to enable them or writing remote settings', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, 'locales'));
  await writeFile(join(f.project, 'locales/en.json'), '{"start":"Start"}');
  await writeFile(join(f.project, 'locales/zh.json'), '{"start":"开始"}');
  f.state.integrations = { cloudSaves: { enabled: true, schemaVersion: 7 }, leaderboards: [board] };
  const result = await prepareGame(f.platform, f.project);
  assert.deepEqual(result.features, { multilingual: true, cloudSaves: true, leaderboards: true });
  assert.deepEqual(result.decisions, []);
  assert.equal(result.integrations.cloudSaves.schemaVersion, 7);
  assert.deepEqual(result.integrations.leaderboards, [board]);
  assert.ok(f.calls.filter(call => call.path.includes('game-integrations')).every(call => !call.options?.body && !call.options?.method));
  assert.deepEqual(await readdir(f.directory), []);
});

test('explicit false is remembered as intent and never disables live capabilities', async t => {
  const f = await fixture(t);
  f.state.integrations = { cloudSaves: { enabled: true, schemaVersion: 7 }, leaderboards: [board] };
  const selected = { multilingual: false, cloudSaves: false, leaderboards: false };
  const first = await prepareGame(f.platform, f.project, { features: selected });
  const next = await prepareGame(f.platform, f.project);
  assert.deepEqual(first.features, selected); assert.deepEqual(next.features, selected);
  assert.deepEqual(next.integrations, f.state.integrations);
  assert.deepEqual(next.decisions, []);
  assert.deepEqual(JSON.parse(await readFile(await f.file(), 'utf8')), selected);
  assert.ok(f.calls.filter(call => call.path.includes('game-integrations')).every(call => !call.options?.body && !call.options?.method));
});

test('saved choices are scoped to account, platform and canonical project directory', async t => {
  const f = await fixture(t);
  await prepareGame(f.platform, f.project, { features: { cloudSaves: true } });
  f.state.token = 'b'.repeat(64);
  assert.deepEqual((await prepareGame(f.platform, f.project)).features, choices);
  f.state.token = 'a'.repeat(64);
  f.platform.origin = 'https://second-platform.example';
  assert.deepEqual((await prepareGame(f.platform, f.project)).features, choices);
  f.platform.origin = 'https://platform.example';
  const second = join(f.base, 'another-game'); await mkdir(second);
  await writeFile(join(second, 'index.html'), '<!doctype html><title>Other game</title>');
  assert.deepEqual((await prepareGame(f.platform, second)).features, choices);
  assert.equal((await prepareGame(f.platform, join(f.project, '.'))).features.cloudSaves, true);
  assert.equal((await readdir(f.directory)).length, 1);
});

test('combined preparation respects an explicit language decision in nested instructions too', async t => {
  const f = await fixture(t);
  for (const multilingual of [false, true]) {
    await prepareGame(f.platform, f.project, { features: { multilingual } });
    const next = await prepareGame(f.platform, f.project);
    assert.equal(next.features.multilingual, multilingual);
    assert.doesNotMatch(next.languageCheck.nextSteps.join('\n'), /先问用户|要不要做成多语言/);
    if (!multilingual) assert.match(next.languageCheck.nextSteps[0], /保留游戏当前语言和已有功能/);
    else assert.match(next.languageCheck.nextSteps[0], /作者已选择接入多语言/);
    assert.match(next.nextSteps[0], /复用 prepare_game 的 inspection/);
  }
});

test('corrupt or non-boolean saved values never become permission; current choices still work', async t => {
  const f = await fixture(t), path = await f.file();
  for (const content of ['{"cloudSaves":true', 'null', '[]', '{"cloudSaves":"true","leaderboards":1}']) {
    await writeFile(path, content);
    assert.deepEqual((await prepareGame(f.platform, f.project)).features, choices);
  }
  await writeFile(path, '{');
  const result = await prepareGame(f.platform, f.project, { features: { cloudSaves: false } });
  assert.equal(result.features.cloudSaves, false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cloudSaves: false });
});

test('oversized and hard-linked preferences are not trusted or overwritten', async t => {
  const f = await fixture(t), path = await f.file();
  await writeFile(path, JSON.stringify({ cloudSaves: true, padding: 'x'.repeat(5000) }));
  const oversized = await prepareGame(f.platform, f.project);
  assert.deepEqual(oversized.features, choices); assert.ok(oversized.preferenceWarning);
  await rm(path);
  const target = join(f.base, 'shared.json'); await writeFile(target, '{"cloudSaves":true}');
  await link(target, path);
  const linked = await prepareGame(f.platform, f.project, { features: { leaderboards: false } });
  assert.deepEqual(linked.features, { ...choices, leaderboards: false }); assert.ok(linked.preferenceWarning);
  assert.equal(await readFile(target, 'utf8'), '{"cloudSaves":true}');
});

test('symlink preference files cannot grant consent or receive writes', async t => {
  const f = await fixture(t), target = join(f.base, 'external.json');
  await writeFile(target, '{"cloudSaves":true}');
  if (!await testSymlink(t, target, await f.file())) return;
  const result = await prepareGame(f.platform, f.project, { features: { leaderboards: false } });
  assert.deepEqual(result.features, { ...choices, leaderboards: false }); assert.ok(result.preferenceWarning);
  assert.equal(await readFile(target, 'utf8'), '{"cloudSaves":true}');
});

test('a symlink ancestor of the preferences directory is rejected', async t => {
  const f = await fixture(t), target = join(f.base, 'outside'), alias = join(f.base, 'linked-parent');
  await mkdir(join(target, 'nested'), { recursive: true });
  if (!await testSymlink(t, target, alias, process.platform === 'win32' ? 'junction' : 'dir')) return;
  f.platform.directory = join(alias, 'nested');
  const path = await f.file(); await writeFile(path, '{"cloudSaves":true}');
  const result = await prepareGame(f.platform, f.project, { features: { multilingual: false } });
  assert.deepEqual(result.features, { ...choices, multilingual: false }); assert.ok(result.preferenceWarning);
  assert.equal(await readFile(path, 'utf8'), '{"cloudSaves":true}');
});

test('remote errors remain unknown rather than masquerading as disabled integrations', async t => {
  const f = await fixture(t);
  f.state.integrations = { error: 'Settings unavailable', code: 'READ_FAILED' };
  const result = await prepareGame(f.platform, f.project);
  assert.deepEqual(result.integrations, f.state.integrations);
  assert.deepEqual(result.features, choices);
  assert.match(result.instructions, /不把未知状态当作未启用/);
  f.state.networkError = true;
  await assert.rejects(prepareGame(f.platform, f.project), /Network unavailable/);
});

test('ambiguous, unauthorized and new projects never fetch a fabricated game configuration', async t => {
  const f = await fixture(t);
  f.state.matches.push({ slug: 'other-game', title: 'Other game' });
  assert.equal((await prepareGame(f.platform, f.project)).code, 'CHOOSE_GAME');
  assert.equal(f.calls.length, 1);
  f.calls.length = 0; f.state.matchError = { error: 'Login required', code: 'AUTH_REQUIRED' };
  assert.equal((await prepareGame(f.platform, f.project)).code, 'AUTH_REQUIRED');
  assert.equal(f.calls.length, 1);
  f.calls.length = 0; delete f.state.matchError; f.state.matches = []; f.state.context = { source: null, previous: null };
  const fresh = await prepareGame(f.platform, f.project);
  assert.equal(fresh.channel, 'new'); assert.equal(fresh.integrations, null);
  assert.equal(f.calls.length, 2); assert.match(f.calls[1].path, /\?projectId=[a-f0-9]{32}$/);
});

test('preparation validates project paths and inspection does not execute build scripts', async t => {
  const f = await fixture(t);
  assert.equal((await prepareGame(f.platform, 'relative-folder')).code, 'INVALID_PROJECT');
  assert.equal(f.calls.length, 0);
  await writeFile(join(f.project, 'package.json'), JSON.stringify({ name: 'test-game', scripts: { build: 'node -e "process.exit(99)"' } }));
  const result = await prepareGame(f.platform, f.project, { buildOptions: { buildScript: 'build', outputDirectory: 'dist' } });
  assert.equal(result.inspection.ready, true); assert.equal(result.inspection.build.script, 'build');
  assert.equal(result.channel, 'local');
});

test('missing account storage cannot erase an explicit choice or persist it unscoped', async t => {
  const f = await fixture(t); f.state.token = null;
  const result = await prepareGame(f.platform, f.project, { features: { cloudSaves: false } });
  assert.equal(result.features.cloudSaves, false); assert.ok(result.preferenceWarning);
  assert.deepEqual(await readdir(f.directory), []);
});

test('an account switch during remote preparation pins reads and never stores A choices for B', async t => {
  for (const switchAt of ['match', 'context', 'game-integrations']) await t.test(switchAt, async t => {
    const f = await fixture(t), tokenA = f.state.token, tokenB = 'b'.repeat(64);
    const fileA = await f.file();
    f.state.token = tokenB;
    const fileB = await f.file();
    await writeFile(fileB, '{"cloudSaves":false}');
    f.state.token = tokenA;
    const request = f.platform.request;
    f.platform.request = async (path, options) => {
      assert.equal(options?.token, tokenA, 'Every remote read must use the starting account');
      const result = await request(path, options);
      if (path.includes(switchAt)) f.state.token = tokenB;
      return result;
    };
    const result = await prepareGame(f.platform, f.project, { features: { cloudSaves: true } });
    assert.equal(result.code, 'ACCOUNT_CHANGED');
    assert.deepEqual(Object.keys(result).sort(), ['code', 'error']);
    assert.equal(await readFile(fileB, 'utf8'), '{"cloudSaves":false}');
    await assert.rejects(readFile(fileA), { code: 'ENOENT' });
    assert.ok(f.calls.length >= 2);
    assert.ok(f.calls.every(call => call.options.token === tokenA));
  });
});

test('a switch during local persistence still writes only the starting account and rejects the result', async t => {
  const f = await fixture(t), tokenA = f.state.token, fileA = await f.file();
  f.state.token = 'b'.repeat(64); const fileB = await f.file(); f.state.token = tokenA;
  let checks = 0;
  f.platform.token = async () => {
    // Start, after release, before preferences, then the final check after local persistence.
    if (++checks === 4) f.state.token = 'b'.repeat(64);
    return f.state.token;
  };
  const result = await prepareGame(f.platform, f.project, { features: { cloudSaves: true } });
  assert.equal(result.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(JSON.parse(await readFile(fileA, 'utf8')), { cloudSaves: true });
  await assert.rejects(readFile(fileB), { code: 'ENOENT' });
  assert.ok(f.calls.every(call => call.options.token === tokenA));
});

test('compatibility clients without token storage keep remote auth errors and local-choice warnings', async t => {
  const f = await fixture(t); delete f.platform.token;
  f.state.matchError = { code: 'AUTH_REQUIRED', error: 'Please connect' };
  assert.equal((await prepareGame(f.platform, f.project)).code, 'AUTH_REQUIRED');
  delete f.state.matchError;
  const result = await prepareGame(f.platform, f.project, { features: { cloudSaves: false } });
  assert.equal(result.features.cloudSaves, false); assert.ok(result.preferenceWarning);
  assert.deepEqual(await readdir(f.directory), []);
});
