import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundle, pageSource } from '../scripts/build.mjs';
import { loadDependency } from '../src/lazy-deps.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const lines = text => text.replace(/\r\n/g, '\n');

test('dist/ matches the source: run npm run bundle after changing src/ or the version', { timeout: 60000 }, async () => {
  assert.equal(lines(await readFile(join(root, 'dist', 'server.js'), 'utf8')) === lines(await bundle()), true, 'dist/server.js is stale: npm run bundle');
  assert.equal(lines(await readFile(join(root, 'dist', 'recorder-page.js'), 'utf8')), lines(await pageSource()), 'dist/recorder-page.js is stale: npm run bundle');
});

test('a first install carries no dependency tree', async () => {
  const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(info.dependencies).sort(), ['mp4-muxer', 'webm-muxer']);
  assert.deepEqual(Object.keys(info.lazyDependencies).sort(), ['esbuild', 'sharp']);
  for (const [name, version] of Object.entries(info.lazyDependencies)) assert.equal(info.devDependencies[name], version, `${name} is tested at the version fetched later`);
  assert.ok(info.files.includes('dist'));
  // npm installs every development dependency of a github: package that has one of these scripts, which undoes all of this.
  for (const script of ['preinstall', 'install', 'postinstall', 'build', 'prepack', 'prepare']) assert.equal(info.scripts[script], undefined, `no "${script}" script`);
});

test('without any node_modules the installed package still starts, from the bundle, with every tool', { timeout: 60000 }, async t => {
  const installed = await mkdtemp(join(tmpdir(), 'mcp-installed-')); t.after(() => rm(installed, { recursive: true, force: true }));
  for (const item of ['src', 'dist', 'package.json']) await cp(join(root, item), join(installed, item), { recursive: true });
  const connect = async file => {
    const client = new Client({ name: 'bundle-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [file], env: { ...process.env, ONEGP_MCP_AUTO_UPDATE: '0' }, stderr: 'ignore' }));
    t.after(() => client.close());
    return client;
  };
  const [bundled, source] = await Promise.all([connect(join(installed, 'src', 'server.js')), connect(join(root, 'src', 'server.js'))]);
  const names = async client => (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(await names(bundled), await names(source));
  const info = JSON.parse((await bundled.callTool({ name: 'get_publisher_info', arguments: {} })).content[0].text);
  assert.equal(info.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
});

test('a heavy dependency is fetched once on first use, at its exact version, and a failure can be retried', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' });
  const directory = await mkdtemp(join(tmpdir(), 'mcp-deps-'));
  const calls = [];
  let online = false;
  const options = { directory, versions: { 'not-installed-pkg': '1.2.3' }, importer: async () => { throw missing; },
    installer: async (name, version) => { calls.push(`${name}@${version}`); if (!online) throw new Error('offline'); } };
  await assert.rejects(loadDependency('not-installed-pkg', options), /第一次用到这个功能要下载 not-installed-pkg.*offline.*检查网络后重试/);
  assert.deepEqual(calls, ['not-installed-pkg@1.2.3']);
  online = true;
  await assert.rejects(loadDependency('not-installed-pkg', options), /下载 not-installed-pkg/, 'the failed attempt is not remembered');
  assert.equal(calls.length, 2);
  await assert.rejects(loadDependency('unregistered-pkg', options), /没有登记 unregistered-pkg/);
  await rm(directory, { recursive: true, force: true });
});

test('a checkout uses the copy it has installed, without downloading', async () => {
  const installer = async () => { throw new Error('must not install'); };
  const sharp = await loadDependency('sharp', { installer });
  assert.equal(typeof sharp.default, 'function');
});
