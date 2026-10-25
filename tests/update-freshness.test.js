import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateFreshnessWarnings } from '../src/update-freshness.js';
import { inspectGame } from '../src/inspect.js';

const file = (name, text) => ({ file: name, data: Buffer.from(text).toString('base64'), encoding: 'base64' });
const codes = files => updateFreshnessWarnings(files).map(warning => warning.code);
const config = routes => file('.vercel/output/config.json', JSON.stringify({ version: 3, routes }));

test('service workers are reported from worker files, page registrations and Godot PWA exports', () => {
  assert.deepEqual(codes([file('index.html', '<script src="game.js"></script>'), file('game.js', 'start()')]), []);
  assert.deepEqual(codes([file('index.html', ''), file('sw.js', 'self.addEventListener("fetch",()=>{})')]), ['SERVICE_WORKER']);
  assert.deepEqual(codes([file('index.html', "<script>navigator.serviceWorker.register('./cache.js')</script>")]), ['SERVICE_WORKER']);
  assert.deepEqual(updateFreshnessWarnings([file('index.html', ''), file('registerSW.js', '')])[0].files, ['registerSW.js']);
  // Godot's engine loader always carries registration code; only a configured worker counts.
  const engine = file('index.js', 'class Engine { installServiceWorker() { return navigator.serviceWorker.register(this.config.serviceWorker); } }');
  assert.deepEqual(codes([file('index.html', 'const GODOT_CONFIG = {"serviceWorker":""};'), engine]), []);
  assert.deepEqual(codes([file('index.html', 'const GODOT_CONFIG = {"serviceWorker":"index.service.worker.js"};'), engine, file('index.service.worker.js', '')]), ['SERVICE_WORKER']);
});

test('long caching is reported only for files whose names do not change between versions', () => {
  const page = file('.vercel/output/static/index.html', ''), hashed = file('.vercel/output/static/assets/index-Bx3kA9qP.js', ''), plain = file('.vercel/output/static/game.pck', '');
  assert.deepEqual(codes([config([{ src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' } }]), page, hashed]), [], 'hashed assets may be cached forever');
  const all = updateFreshnessWarnings([config([{ src: '/(.*)', headers: { 'Cache-Control': 'public, max-age=86400' } }]), page, hashed, plain]);
  assert.deepEqual(all.map(warning => warning.code), ['LONG_CACHE']);
  assert.deepEqual(all[0].files, ['game.pck', 'index.html']);
  assert.deepEqual(codes([config([{ src: '/(.*)', headers: { 'cache-control': 'public, max-age=0, must-revalidate' } }]), page, plain]), []);
  assert.deepEqual(codes([config([{ src: '/(', headers: { 'cache-control': 'immutable' } }, { handle: 'filesystem' }]), page]), [], 'invalid or header-less routes are ignored');
  assert.deepEqual(codes([file('.vercel/output/functions/api.func/sw.js', '')]), [], 'server functions are not browser files');
});

test('inspection carries the reminders without blocking a ready game', async t => {
  const dir = await mkdtemp(join(tmpdir(), '1gp-fresh-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), "<!doctype html><title>Star</title><script>navigator.serviceWorker.register('sw.js')</script>");
  await writeFile(join(dir, 'sw.js'), '');
  const info = await inspectGame(dir);
  assert.equal(info.ready, true);
  assert.deepEqual(info.warnings.map(warning => warning.code), ['SERVICE_WORKER']);
  assert.deepEqual(info.warnings[0].files, ['index.html', 'sw.js']);
  const clean = await mkdtemp(join(tmpdir(), '1gp-fresh-')); t.after(() => rm(clean, { recursive: true, force: true }));
  await mkdir(join(clean, 'assets')); await writeFile(join(clean, 'index.html'), '<!doctype html><title>Star</title>');
  assert.equal((await inspectGame(clean)).warnings, undefined);
});
