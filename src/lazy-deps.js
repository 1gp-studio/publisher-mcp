import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };
import { npm } from './npm.js';

// sharp (images) and esbuild (Vercel functions) carry native programs of tens of megabytes, and many authors
// never need one of them, so a first install leaves them out: each is fetched, at the exact version in
// package.json, the first time a tool needs it. It sits outside the versioned server folders, so it survives
// updates. A checkout has them installed already and uses those.
const defaultDirectory = join(homedir(), '.config', '1gp-studio', 'mcp-deps');
const loaded = new Map();

async function install(name, version, dir) {
  const temp = `${dir}.part-${process.pid}-${Date.now()}`;
  await mkdir(temp, { recursive: true });
  try {
    await writeFile(join(temp, 'package.json'), '{ "private": true }\n');
    await npm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `${name}@${version}`], temp);
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    if (!found(name, dir)) throw error;   // another session may have finished first
  }
}
const found = (name, dir) => { try { return createRequire(join(dir, 'package.json')).resolve(name); } catch { return null; } };

async function load(name, { directory, versions, installer, importer }) {
  try { return await importer(name); } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  const version = versions[name];
  if (!version) throw new Error(`没有登记 ${name} 的版本。`);
  const dir = join(directory, `${name}-${version}`);
  try {
    if (!found(name, dir)) await installer(name, version, dir);
    return await importer(pathToFileURL(found(name, dir)).href);
  } catch (error) { throw new Error(`第一次用到这个功能要下载 ${name}，没有下载成功（${error.message}）。检查网络后重试。`); }
}

export function loadDependency(name, { directory = defaultDirectory, versions = packageInfo.lazyDependencies, installer = install, importer = specifier => import(specifier) } = {}) {
  if (!loaded.has(name)) loaded.set(name, load(name, { directory, versions, installer, importer }).catch(error => { loaded.delete(name); throw error; }));
  return loaded.get(name);
}
