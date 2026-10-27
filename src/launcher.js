import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };
import { defaultPlatformOrigin } from './platform.js';

// The installed command. It keeps the connection with the AI client and runs the publishing server behind it,
// moving to the version the platform recommends (/mcp/release.json) as soon as it appears: calls in flight finish
// on the old process, new ones go to the new one, and the client is told the tool list changed, so nobody edits a
// config or restarts a conversation. The platform's choice is followed both ways, so moving it back rolls back.
const here = dirname(fileURLToPath(import.meta.url));
const exitedError = 'AIWANNA MCP 进程意外退出，请重试这一步。';
export const defaultCacheDirectory = join(homedir(), '.config', '1gp-studio', 'mcp');

export async function fetchRelease(origin = process.env.ONEGP_PLATFORM_URL || defaultPlatformOrigin) {
  const response = await fetch(new URL('/mcp/release.json', origin), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`平台返回 ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!/^\d+\.\d+\.\d+$/.test(body?.version) || !/^[0-9a-f]{40}$/.test(body?.commit)) throw new Error('平台给的版本信息格式不对');
  return { version: body.version, commit: body.commit };
}

const installed = async dir => {
  try { return JSON.parse(await readFile(join(dir, 'node_modules', '@1gp-studio', 'publisher-mcp', 'package.json'), 'utf8')).version; } catch { return null; }
};
const serverIn = dir => join(dir, 'node_modules', '@1gp-studio', 'publisher-mcp', 'src', 'server.js');

function npm(args, cwd) {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && /npm-cli\.js$/.test(path) && existsSync(path));
  const shell = !cli && process.platform === 'win32';
  const [command, rest] = cli ? [process.execPath, [cli, ...args]] : [shell ? 'npm.cmd' : 'npm', shell ? args.map(arg => `"${arg}"`) : args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, rest, { cwd, shell, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm 安装失败（${code}）：${errors.trim().split('\n').at(-1) ?? ''}`)));
  });
}

// Each version is installed once per computer, from the exact commit the platform names, next to the others.
export async function installVersion({ version, commit }, cacheDirectory = defaultCacheDirectory, log = () => {}) {
  const dir = join(cacheDirectory, `${version}-${commit.slice(0, 12)}`);
  if (await installed(dir) === version) return serverIn(dir);
  const temp = `${dir}.part-${process.pid}-${Date.now()}`;
  await mkdir(temp, { recursive: true });
  try {
    await writeFile(join(temp, 'package.json'), '{ "private": true }\n');
    log(`installing ${version} (${commit.slice(0, 7)})`);
    await npm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `https://codeload.github.com/1gp-studio/publisher-mcp/tar.gz/${commit}`], temp);
    if (await installed(temp) !== version) throw new Error(`提交 ${commit.slice(0, 7)} 不是 ${version}`);
  } catch (error) { await rm(temp, { recursive: true, force: true }).catch(() => {}); throw error; }
  try { await rename(temp, dir); } catch {   // another session installed it first, or the folder is busy
    if (await installed(dir) !== version) return serverIn(temp);
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
  return serverIn(dir);
}

// Versions no session has started for a week are removed; the one in use is touched at every start.
async function prune(cacheDirectory, keep) {
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of await readdir(cacheDirectory).catch(() => [])) {
    const dir = join(cacheDirectory, name);
    if (name === 'current.json' || keep.some(file => file.startsWith(dir + '\\') || file.startsWith(dir + '/'))) continue;
    const used = await stat(name.includes('.part-') ? dir : join(dir, '.used')).catch(() => null);
    if (!used || used.mtimeMs < week) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const spawnServer = serverFile => spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  env: { ...process.env, ONEGP_MCP_LAUNCHER: packageInfo.version } });

export function startLauncher({ input = process.stdin, output = process.stdout, bundled = { version: packageInfo.version, serverFile: join(here, 'server.js') },
  release = () => fetchRelease(), install = installVersion, cacheDirectory = defaultCacheDirectory, start = spawnServer,
  checkEveryMs = 600000, askEveryMs = 30000, log = line => process.stderr.write(`[aiwanna-mcp] ${line}\n`) } = {}) {
  const write = message => { if (!closed) output.write(JSON.stringify(message) + '\n'); };
  output.on?.('error', () => close(0));
  const children = new Set(), forwarded = new Map();
  let init = null, initialized = false, current = null, restarting = null, checking = null, notice = null, lastCheck = 0, nextId = 0, crashes = [], closed = false;
  let finish; const done = new Promise(resolve => { finish = resolve; });

  const send = (child, message) => { if (!child.dead) child.proc.stdin.write(JSON.stringify(message) + '\n'); };
  function run(target) {
    const child = { ...target, proc: start(target.serverFile), pending: new Map(), waiting: new Map(), dead: false };
    children.add(child);
    child.proc.stdin.on('error', () => {});
    createInterface({ input: child.proc.stdout }).on('line', line => fromChild(child, line));
    child.proc.on('error', () => exited(child));
    child.proc.on('exit', () => exited(child));
    if (target.serverFile !== bundled.serverFile) writeFile(join(target.serverFile, '..', '..', '..', '..', '..', '.used'), '').catch(() => {});
    return child;
  }
  const request = (child, method, params) => new Promise((resolve, reject) => {
    const id = `launcher-${++nextId}`, timer = setTimeout(() => reject(new Error('新版启动超时')), 90000);
    child.waiting.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(message.error.message)); else resolve(message.result); });
    send(child, { jsonrpc: '2.0', id, method, params });
  });
  function retire(child) {
    if (child === current || child.pending.size) return;
    child.proc.stdin.end();
    setTimeout(() => child.proc.kill(), 5000).unref?.();
  }

  // A new process gets the client's own handshake before it takes any call.
  async function switchTo(target) {
    const child = run(target);
    try {
      if (init) {
        const result = await request(child, 'initialize', init.params);
        if (result?.serverInfo?.version !== target.version) throw new Error(`新版报告的版本是 ${result?.serverInfo?.version}`);
        if (initialized) send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
      }
    } catch (error) { child.dead = true; children.delete(child); child.proc.kill(); throw error; }
    const old = current;
    current = child;
    if (old) retire(old);
    if (old && old.version !== child.version) {
      notice = `AIWANNA MCP 已自动换到 ${child.version}（之前是 ${old.version}），工具列表已刷新，直接使用即可。`;
      log(`now running ${child.version}`);
      if (init) for (const kind of ['tools', 'prompts']) write({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` });
    }
  }

  async function upgrade(target) {
    if (target.version === current.version) return;
    const next = target.version === bundled.version ? bundled : { ...target, serverFile: await install(target, cacheDirectory, log) };
    await switchTo(next);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, 'current.json'), JSON.stringify({ version: next.version, commit: next.commit ?? null, serverFile: next.serverFile }, null, 2));
    prune(cacheDirectory, [next.serverFile, bundled.serverFile]).catch(() => {});
  }
  function check() {
    checking ??= (async () => {
      lastCheck = Date.now();
      try { await upgrade(await release()); return null; }
      catch (error) { log(`update check: ${error.message}`); return `这次没能更新 AIWANNA MCP（${error.message}），继续使用 ${current.version}。`; }
      finally { checking = null; }
    })();
    return checking;
  }

  function exited(child) {
    if (child.dead) return;
    child.dead = true;
    children.delete(child);
    for (const id of child.pending.keys()) write({ jsonrpc: '2.0', id, error: { code: -32603, message: exitedError } });
    child.pending.clear();
    for (const answer of child.waiting.values()) answer({ error: { message: exitedError } });
    if (child !== current || closed) return;
    // The running server stopped by itself: start this package's own server again.
    crashes = [...crashes.filter(time => Date.now() - time < 60000), Date.now()];
    if (crashes.length > 3) { log('the server keeps exiting'); return close(1); }
    restarting = switchTo(bundled).catch(error => { log(`restart: ${error.message}`); close(1); }).finally(() => { restarting = null; });
  }

  function fromChild(child, line) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const answer = child.waiting.get(message.id);
      if (answer) { child.waiting.delete(message.id); return answer(message); }
      const call = child.pending.get(message.id);
      if (!call) return;
      child.pending.delete(message.id);
      if (call.method === 'initialize' && message.result) {
        const capabilities = message.result.capabilities ??= {};
        for (const kind of ['tools', 'prompts']) if (capabilities[kind]) capabilities[kind].listChanged = true;
      }
      if (call.method === 'tools/call' && message.result) {
        const notes = [child === current && notice, call.note].filter(Boolean);
        if (child === current) notice = null;
        if (notes.length) message.result.content = [...(message.result.content ?? []), ...notes.map(text => ({ type: 'text', text }))];
      }
      write(message);
      return retire(child);
    }
    if (message.id !== undefined) {   // the server asks the client something: answers find their way back
      const id = `server-${++nextId}`;
      forwarded.set(id, { child, id: message.id });
      return write({ ...message, id });
    }
    if (child === current || !message.method?.endsWith('/list_changed')) write(message);
  }

  async function fromClient(line) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method === undefined) {
      const target = forwarded.get(message.id);
      if (target) { forwarded.delete(message.id); send(target.child, { ...message, id: target.id }); }
      return;
    }
    if (message.method === 'initialize') init = message;
    if (message.method === 'notifications/initialized') initialized = true;
    if (message.method === 'notifications/cancelled') {
      const owner = [...children].find(child => child.pending.has(message.params?.requestId));
      return owner && send(owner, message);
    }
    let note = null;
    if (message.method === 'tools/call') {
      // Asking which version runs is the moment to move to the newest one, so the answer is about it.
      const asking = message.params?.name === 'get_publisher_info';
      if (Date.now() - lastCheck >= (asking ? askEveryMs : checkEveryMs)) { const pending = check(); if (asking) note = await pending; }
      else if (asking && checking) note = await checking;
    }
    if (restarting) await restarting;
    if (message.id === undefined) return send(current, message);
    current.pending.set(message.id, { method: message.method, note });
    send(current, message);
  }

  function close(code = 0) {
    if (closed) return;
    closed = true;
    for (const child of children) { child.dead = true; child.proc.stdin.end(); child.proc.kill(); }
    finish(code);
  }

  (async () => {
    let first = bundled;
    try {
      const saved = JSON.parse(await readFile(join(cacheDirectory, 'current.json'), 'utf8'));
      if (/^\d+\.\d+\.\d+$/.test(saved.version) && typeof saved.serverFile === 'string' && existsSync(saved.serverFile)) first = saved;
    } catch { /* no update yet */ }
    current = run(first);
    createInterface({ input }).on('line', fromClient).on('close', () => close(0));
    check();
  })();
  return { done };
}
