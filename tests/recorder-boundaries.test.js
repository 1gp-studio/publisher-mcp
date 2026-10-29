import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordGameVideo } from '../src/recorder.js';
import { testSymlink } from './helpers/symlink.js';

const video = Buffer.from('recording fixture bytes');
const shot = Buffer.from('screenshot fixture bytes');
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rec-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), outside = join(root, 'outside');
  await mkdir(project); await mkdir(outside);
  await writeFile(join(project, 'index.html'), '<!doctype html><html><head></head><body><script src="game.js"></script></body></html>');
  await writeFile(join(project, 'game.js'), 'window.game = true;');
  await writeFile(join(project, 'director.js'), '// fixture director');
  return { root, project, outside };
}

// Exercise the actual loopback server and final filesystem writes. Only Chrome's
// frame encoder is replaced: the real-browser test separately verifies encoding.
async function record(f, requests = async () => {}, options = {}) {
  let requestError, launches = 0, running;
  const result = await recordGameVideo({ projectDirectory: f.project, director: 'director.js', browser: 'fixture-browser', timeoutSeconds: 5, ...options,
    launch(_browser, args) {
      launches++;
      const address = args.find(arg => arg.startsWith('http://127.0.0.1:'));
      const child = new EventEmitter(); child.kill = () => {};
      running = (async () => {
        try { await requests(address); } catch (error) { requestError = error; }
        try {
          await fetch(new URL('/__video', address), { method: 'POST', body: video,
            headers: { 'x-container': 'mp4', 'x-codec': 'fixture', 'x-frames': '1', 'x-size': '64x64' } });
        } catch (error) { requestError ??= error; child.emit('error', error); }
      })();
      return child;
    },
  });
  await running;
  assert.ifError(requestError);
  return { result, launches };
}

async function putShot(address, name) {
  const url = new URL('/__shot', address); url.searchParams.set('name', name);
  assert.equal((await fetch(url, { method: 'POST', body: shot })).status, 204);
}

test('the actual recording server serves game assets but denies private project files, even to same-origin scripts', async t => {
  const f = await fixture(t);
  const allowed = {
    'assets/game.mjs': 'export const game = true;', 'assets/data.json': '{"level":1}',
    'assets/style.css': 'canvas { display:block }', 'assets/game.wasm': Buffer.from([0, 97, 115, 109]),
    'assets/export.pck': Buffer.from([1, 2, 3]), 'assets/music.ogg': Buffer.from([4, 5, 6]),
    'assets/font.woff2': Buffer.from([7, 8, 9]),
  };
  const denied = {
    '.env': 'FAKE_FIXTURE_SECRET=private', '.env.local': 'ANOTHER_FIXTURE=private',
    '.git/config': '[fixture]', 'nested/.hidden/data.json': '{"private":true}',
    '.npmrc': 'fixture-private', 'credentials.json': '{"password":"fixture-only"}',
    'credentials-backup.txt': 'fixture-private', 'secrets/token.txt': 'fixture-private',
    'secret_key.json': '{"fixture":"private"}', 'id_rsa.pub': 'fixture-private',
    'private.pem': 'fixture-private', 'private.key': 'fixture-private', 'game.js.map': 'fixture-private',
    'package.json': '{"fixture":"private"}', 'vite.config.js': '// private config',
    'api/data.json': '{"fixture":"private"}', 'server/internal.js': '// private backend',
    'server.js': '// private backend', 'node_modules/pkg/index.js': '// private dependency',
    'assets/config.json': JSON.stringify({ key: `sb_secret_${'x'.repeat(24)}` }),
    'assets/private.txt': '-----BEGIN PRIVATE KEY-----\nfixture-only',
  };
  for (const [path, bytes] of Object.entries({ ...allowed, ...denied })) {
    await mkdir(dirname(join(f.project, path)), { recursive: true }); await writeFile(join(f.project, path), bytes);
  }
  // Hard-link aliases do not retain the private name; metadata must still stop them.
  await link(join(f.project, '.env'), join(f.project, 'assets', 'innocent.txt'));
  const { result } = await record(f, async address => {
    assert.equal((await fetch(address)).status, 200);
    for (const [path, bytes] of Object.entries({ 'game.js': 'window.game = true;', ...allowed })) {
      const response = await fetch(new URL(`/${path}`, address));
      assert.equal(response.status, 200, path); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes));
    }
    for (const path of [...Object.keys(denied), 'assets/innocent.txt', '%2eenv', '%2e%67it/config', 'nested%2f..%2f.env', 'assets%5c..%5c.env', '.env::$DATA']) {
      const response = await fetch(new URL(`/${path}`, address), { headers: { Origin: new URL(address).origin, 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(response.status, 404, path); assert.equal(await response.text(), 'not found', path);
    }
    await putShot(address, 'normal');
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await readFile(join(f.project, result.path)), video);
  assert.deepEqual(await readFile(join(f.project, result.screenshots[0])), shot);
});

test('a public-looking symlink or junction cannot expose hidden or external game resources', async t => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.private'));
  await writeFile(join(f.project, '.private', 'data.json'), '{"fixture":"private"}');
  await writeFile(join(f.outside, 'data.json'), '{"fixture":"outside"}');
  if (!await testSymlink(t, join(f.project, '.private'), join(f.project, 'assets'), directoryLink)) return;
  if (!await testSymlink(t, f.outside, join(f.project, 'external'), directoryLink)) return;
  const { result } = await record(f, async address => {
    for (const path of ['/assets/data.json', '/external/data.json']) assert.equal((await fetch(new URL(path, address))).status, 404, path);
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('linked output directories and invalid output names are refused before browser launch', async t => {
  const f = await fixture(t);
  const protectedFile = join(f.outside, 'preview.mp4'); await writeFile(protectedFile, 'unrelated');
  if (!await testSymlink(t, f.outside, join(f.project, 'linked'), directoryLink)) return;
  for (const options of [
    { out: 'linked/preview.mp4' }, { shotsDirectory: 'linked/shots' },
    { out: '../outside/preview.mp4' }, { shotsDirectory: '../outside' },
    { out: 'CON.mp4' }, { out: 'safe/video.mp4:stream' }, { shotsDirectory: 'safe/dir.' }, { out: 'preview.txt' },
  ]) {
    const { result, launches } = await record(f, undefined, options);
    assert.equal(result.code, 'INVALID_REQUEST', JSON.stringify(options)); assert.equal(launches, 0);
  }
  assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
  assert.deepEqual(await readdir(f.outside), ['preview.mp4']);
});

test('an existing hard-linked output file cannot overwrite another project file', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'preview.mp4');
  await writeFile(protectedFile, 'unrelated'); await link(protectedFile, join(f.project, 'preview.mp4'));
  const { result, launches } = await record(f, undefined, { out: 'preview.mp4' });
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(launches, 0);
  assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
});

test('an existing symlink output file is refused before recording', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'preview.mp4');
  await writeFile(protectedFile, 'unrelated');
  if (!await testSymlink(t, protectedFile, join(f.project, 'preview.mp4'))) return;
  const { result, launches } = await record(f, undefined, { out: 'preview.mp4' });
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(launches, 0);
  assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
});

test('all screenshot destinations are checked before writing the video or any screenshot', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'capture.png');
  await writeFile(protectedFile, 'unrelated'); await mkdir(join(f.project, 'shots'));
  await link(protectedFile, join(f.project, 'shots', 'capture.png'));
  const { result, launches } = await record(f, async address => { await putShot(address, 'safe'); await putShot(address, 'capture'); }, { shotsDirectory: 'shots' });
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(launches, 1);
  assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
  await assert.rejects(readFile(join(f.project, '1gp-kit', 'preview.mp4')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.project, 'shots', 'safe.png')), { code: 'ENOENT' });
});

test('a screenshot symlink discovered after recording never overwrites its target', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'capture.png');
  await writeFile(protectedFile, 'unrelated'); await mkdir(join(f.project, 'shots'));
  if (!await testSymlink(t, protectedFile, join(f.project, 'shots', 'capture.png'))) return;
  const { result } = await record(f, address => putShot(address, 'capture'), { shotsDirectory: 'shots' });
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
  await assert.rejects(readFile(join(f.project, '1gp-kit', 'preview.mp4')), { code: 'ENOENT' });
});

test('output directory changes while recording are rechecked before writing', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'preview.mp4');
  await writeFile(protectedFile, 'unrelated');
  if (!await testSymlink(t, f.outside, join(f.project, 'later'), directoryLink)) return;
  const { result } = await record(f, () => rename(join(f.project, 'later'), join(f.project, '1gp-kit')));
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
  assert.deepEqual(await readdir(f.outside), ['preview.mp4']);
});

test('screenshot directory changes while recording are rechecked before writing', async t => {
  const f = await fixture(t), protectedFile = join(f.outside, 'capture.png');
  await writeFile(protectedFile, 'unrelated');
  if (!await testSymlink(t, f.outside, join(f.project, 'later'), directoryLink)) return;
  const { result } = await record(f, async address => {
    await rename(join(f.project, 'later'), join(f.project, 'shots'));
    await putShot(address, 'capture');
  }, { out: 'video.mp4', shotsDirectory: 'shots' });
  assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(await readFile(protectedFile, 'utf8'), 'unrelated');
  await assert.rejects(readFile(join(f.project, 'video.mp4')), { code: 'ENOENT' });
});

test('replacing the project root while recording cannot create output folders outside it', async t => {
  const f = await fixture(t);
  if (!await testSymlink(t, f.outside, join(f.root, 'later'), directoryLink)) return;
  const { result } = await record(f, async () => {
    await rename(f.project, join(f.root, 'original-project'));
    await rename(join(f.root, 'later'), f.project);
  });
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.deepEqual(await readdir(f.outside), []);
});

test('safe output replacement, root screenshots and hostile shot names remain inside the project', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'preview.mp4'), 'old recording');
  const { result } = await record(f, async address => {
    for (const name of ['../outside/evil', 'CON', '.env', 'folder\\capture', '..', 'frame:stream']) await putShot(address, name);
  }, { out: './preview.mp4', shotsDirectory: '.' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await readFile(join(f.project, 'preview.mp4')), video);
  assert.deepEqual(result.screenshots, ['outside-evil.png', 'shot-CON.png', 'env.png', 'folder-capture.png', 'shot-5.png', 'frame-stream.png']);
  for (const path of result.screenshots) assert.deepEqual(await readFile(join(f.project, path)), shot);
  assert.deepEqual(await readdir(f.outside), []);
  assert.ok((await readdir(f.project)).every(name => !name.startsWith('.1gp-record-')), 'temporary output files are cleaned up');
});
