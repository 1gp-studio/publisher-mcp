import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fetchRelease, startLauncher } from '../src/launcher.js';

// A stand-in publishing server of one version: it says which version runs, has a slow call and can crash.
const fakeServer = (version, extra = '') => `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
const server = new McpServer({ name: '1gp-publisher', version: '${version}' });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
server.registerTool('get_publisher_info', { inputSchema: {} }, () => text({ version: '${version}', launcher: process.env.ONEGP_MCP_LAUNCHER ?? null }));
server.registerTool('slow', { inputSchema: {} }, async () => { await new Promise(r => setTimeout(r, 800)); return text({ version: '${version}' }); });
server.registerTool('crash', { inputSchema: {} }, () => process.exit(3));
${extra}
await server.connect(new StdioServerTransport());
`;

class StreamTransport {
  constructor(input, output) { this.input = input; this.output = output; }
  async start() { createInterface({ input: this.input }).on('line', line => this.onmessage?.(JSON.parse(line))); }
  async send(message) { this.output.write(JSON.stringify(message) + '\n'); }
  async close() { this.output.end(); this.onclose?.(); }
}

async function setup(t, options) {
  const toLauncher = new PassThrough(), fromLauncher = new PassThrough();
  const launcher = startLauncher({ input: toLauncher, output: fromLauncher, checkEveryMs: 1e9, askEveryMs: 0, log: () => {}, ...options });
  const client = new Client({ name: 'test', version: '1.0.0' });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await client.connect(new StreamTransport(fromLauncher, toLauncher));
  t.after(async () => { toLauncher.end(); await launcher.done; });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { data: JSON.parse(result.content[0].text), notes: result.content.slice(1).map(item => item.text) };
  };
  return { client, call, changed: () => changed, launcher };
}

async function files(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (name, version, extra) => { const file = join(dir, `${name}.mjs`); await writeFile(file, fakeServer(version, extra)); return file; };
  return { dir, write };
}
const commit = digit => digit.repeat(40);

test('asking for the version moves to the recommended one, tells the client and lets calls in flight finish on the old process', { timeout: 60000 }, async t => {
  const { dir, write } = await files(t);
  const bundled = { version: '1.0.0', serverFile: await write('bundled', '1.0.0') };
  const newer = await write('newer', '1.1.0', "server.registerTool('fresh', { inputSchema: {} }, () => text({ fresh: true }));");
  let recommended = { version: '1.0.0', commit: commit('a') };
  const installs = [];
  const install = async target => { installs.push(target); return newer; };
  const cacheDirectory = join(dir, 'cache');
  const s = await setup(t, { bundled, release: async () => recommended, install, cacheDirectory });

  const first = await s.call('get_publisher_info');
  assert.equal(first.data.version, '1.0.0'); assert.ok(first.data.launcher, 'the server knows it runs under the launcher');
  assert.deepEqual(first.notes, []); assert.deepEqual(installs, [], 'the recommended version is the bundled one: nothing to install');
  assert.ok(!(await s.client.listTools()).tools.some(tool => tool.name === 'fresh'));

  recommended = { version: '1.1.0', commit: commit('b') };
  const slow = s.call('slow');
  await new Promise(r => setTimeout(r, 100));
  const info = await s.call('get_publisher_info');
  assert.equal(info.data.version, '1.1.0', 'the answer comes from the new version');
  assert.match(info.notes[0], /已自动换到 1\.1\.0（之前是 1\.0\.0）/);
  assert.deepEqual(installs, [recommended]);
  assert.equal((await slow).data.version, '1.0.0', 'the call in flight finished on the old process');
  assert.ok(s.changed() >= 1, 'the client was told the tools changed');
  assert.ok((await s.client.listTools()).tools.some(tool => tool.name === 'fresh'));
  assert.equal((await s.call('fresh')).data.fresh, true);
  assert.deepEqual((await s.call('slow')).notes, [], 'the notice is given once');
  assert.equal(JSON.parse(await readFile(join(cacheDirectory, 'current.json'), 'utf8')).version, '1.1.0');

  // Moving the recommendation back rolls back, to the bundled server without installing.
  recommended = { version: '1.0.0', commit: commit('a') };
  assert.equal((await s.call('get_publisher_info')).data.version, '1.0.0');
  assert.equal(installs.length, 1);
});

test('a later start begins on the last version it moved to', { timeout: 60000 }, async t => {
  const { dir, write } = await files(t);
  const cacheDirectory = join(dir, 'cache');
  const newer = await write('newer', '1.1.0');
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, 'current.json'), JSON.stringify({ version: '1.1.0', commit: commit('b'), serverFile: newer }));
  const s = await setup(t, { bundled: { version: '1.0.0', serverFile: await write('bundled', '1.0.0') }, release: async () => { throw new Error('offline'); },
    install: async () => { throw new Error('must not install'); }, cacheDirectory, askEveryMs: 1e9 });
  assert.equal(s.client.getServerVersion().version, '1.1.0');
  assert.equal((await s.call('slow')).data.version, '1.1.0');
});

test('a failed check or a broken new version keeps the running one, and a crash falls back to the bundled server', { timeout: 60000 }, async t => {
  const { dir, write } = await files(t);
  const bundled = { version: '1.0.0', serverFile: await write('bundled', '1.0.0') };
  const broken = join(dir, 'broken.mjs'); await writeFile(broken, 'process.exit(2);');
  const newer = await write('newer', '1.1.0');
  let recommended = () => { throw new Error('offline'); };
  const s = await setup(t, { bundled, release: async () => recommended(), install: async target => target.version === '1.2.0' ? broken : newer, cacheDirectory: join(dir, 'cache') });

  const offline = await s.call('get_publisher_info');
  assert.equal(offline.data.version, '1.0.0'); assert.match(offline.notes[0], /没能更新.*offline.*继续使用 1\.0\.0/);
  recommended = () => ({ version: '1.2.0', commit: commit('c') });
  const failed = await s.call('get_publisher_info');
  assert.equal(failed.data.version, '1.0.0'); assert.match(failed.notes[0], /没能更新/);

  recommended = () => ({ version: '1.1.0', commit: commit('d') });
  assert.equal((await s.call('get_publisher_info')).data.version, '1.1.0');
  await assert.rejects(s.client.callTool({ name: 'crash', arguments: {} }), /意外退出/);
  assert.equal((await s.call('slow')).data.version, '1.0.0', 'the bundled server took over');
});

test('the recommended version is read from the platform and checked', async t => {
  let body = { version: '0.16.0', commit: commit('e') };
  const server = createServer((request, response) => {
    if (request.url !== '/mcp/release.json') { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await fetchRelease(origin), body);
  for (const bad of [{ version: 'latest', commit: commit('e') }, { version: '0.16.0', commit: 'main' }, null]) {
    body = bad;
    await assert.rejects(fetchRelease(origin), /格式不对/);
  }
});
