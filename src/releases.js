import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { updateRoute } from './github-update.js';
const excluded = /^(?:\..*|node_modules|dist|build|out|vendor|coverage|target)$/i;
const secret = /^(?:credentials.*|secrets.*|.*\.(?:pem|key))$/i;
export async function sourceSnapshot(directory) {
  if (!isAbsolute(directory)) throw new Error('Project directory must be absolute');
  const root = await realpath(directory), files = {}; let total = 0;
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes:true })) {
      if (excluded.test(entry.name) || secret.test(entry.name)) continue;
      const name = prefix + entry.name, absolute = join(path,entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute,name+'/'); continue; }
      if (!entry.isFile() || name.length>240) continue;
      const stat = await lstat(absolute);
      total += stat.size;
      if (Object.keys(files).length >= 1000 || total>64*1024*1024) throw new Error('Release comparison exceeds 1000 source files or 64 MiB; narrow the project directory before publishing.');
      files[name] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    }
  }
  await walk(root);
  let commit;
  try { const {stdout} = await exec('git',['-C',root,'rev-parse','HEAD'],{timeout:10000,maxBuffer:4096}); if(/^[a-f0-9]{40}$/.test(stdout.trim()))commit=stdout.trim(); } catch {}
  return { projectId:createHash('sha256').update(root).digest('hex').slice(0,32), sourceFiles:files, ...(commit?{sourceCommit:commit}:{}) };
}
export function compareSources(previous, current) {
  if (!previous || !Object.keys(previous).length) return { baselineAvailable:false, added:[], changed:[], removed:[] };
  return { baselineAvailable:true, added:Object.keys(current).filter(k=>!previous[k]).sort(), changed:Object.keys(current).filter(k=>previous[k]&&previous[k]!==current[k]).sort(), removed:Object.keys(previous).filter(k=>!current[k]).sort() };
}
export async function prepareRelease(platform, directory, gameSlug, dockerProject) {
  const snapshot = await sourceSnapshot(directory);
  const params = new URLSearchParams(gameSlug ? {slug:gameSlug} : dockerProject ? {dockerProject} : {projectId:snapshot.projectId});
  const context = await platform.request('/api/publish/releases/context?'+params);
  if(context.error)return context;
  // How this game is published decides the update route (GitHub rebuild, local upload, link, Docker).
  return { ...context, ...updateRoute(context), previous: context.previous ? {...context.previous,source_manifest:undefined}:null,
    comparison:compareSources(context.previous?.source_manifest,snapshot.sourceFiles),
    sourceCommit:snapshot.sourceCommit,
    instructions:'Read the changed local files to understand gameplay, levels, balance, fixes, UX and assets. File names alone do not establish major/minor changes. Use major for substantial redesign/save incompatibility, minor for new gameplay or levels, patch for fixes/balance, assets for resource-only changes (patch increment). Start at 1.0.0. Choose the corresponding suggested version and write concise player-facing notes by relevant area. If no baseline exists, inspect actual code and describe only verified changes; never invent a comparison. Then follow channel/nextSteps: supply release {version,title,notes,changeType} to the matching tool (update_github_game, publish_game, publish_link or publish_docker_game); the platform attaches notes to the build and exposes them only after success.' };
}
