import { updateApprovalGuidance, updateHistoryGuidance } from './update-approval-guidance.js';
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { updateRoute } from './github-update.js';
import { findMyGame } from './game-match.js';
import { isReleaseSourcePath } from './source-files.js';
const git = async (root, args) => (await exec('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const commitId = /^[a-f0-9]{40}$/;
const projectIdOf = root => createHash('sha256').update(root).digest('hex').slice(0, 32);
export async function gitHead(directory) {
  try { const head = (await git(directory, ['rev-parse', 'HEAD'])).trim(); return commitId.test(head) ? head : undefined; } catch { return undefined; }
}
// Link games: the platform never receives their files, so a release compares git commits instead of
// hashing the project. Paths are relative to the project folder, which may sit inside a larger repository.
const logLimit = 100;
export async function compareCommits(root, previous, head) {
  const none = { baselineAvailable: false, method: 'git', added: [], changed: [], removed: [] };
  if (!head || !commitId.test(previous ?? '')) return none;
  try {
    await git(root, ['cat-file', '-e', `${previous}^{commit}`]);
    const fields = (await git(root, ['diff', '--relative', '--no-renames', '--name-status', '-z', `${previous}..${head}`, '--', '.'])).split('\0');
    const added = [], changed = [], removed = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [status, path] = [fields[index], fields[index + 1]];
      if (!path || /^1gp-kit(?:[\\/]|$)/i.test(path)) continue;
      (status === 'A' ? added : status === 'D' ? removed : changed).push(path);
    }
    const log = (await git(root, ['log', '--oneline', '--no-decorate', `--max-count=${logLimit + 1}`, `${previous}..${head}`, '--', '.'])).split('\n').filter(Boolean);
    return { baselineAvailable: true, method: 'git', from: previous, to: head, added: added.sort(), changed: changed.sort(), removed: removed.sort(),
      log: log.slice(0, logLimit), ...(log.length > logLimit ? { logTruncated: true } : {}) };
  } catch { return none; }
}
export async function sourceSnapshot(directory) {
  if (!isAbsolute(directory)) throw new Error('Project directory must be absolute');
  const root = await realpath(directory), files = {}; let total = 0;
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes:true })) {
      if (!isReleaseSourcePath(prefix + entry.name)) continue;
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
  const commit = await gitHead(root);
  return { projectId:projectIdOf(root), sourceFiles:files, ...(commit?{sourceCommit:commit}:{}) };
}
export function compareSources(previous, current) {
  // Older MCP manifests may contain promotion media. Ignore it on both sides without rewriting history.
  const gameSource = files => Object.fromEntries(Object.entries(files ?? {}).filter(([path]) => !/^1gp-kit(?:[\\/]|$)/i.test(path)));
  previous = gameSource(previous); current = gameSource(current);
  if (!previous || !Object.keys(previous).length) return { baselineAvailable:false, added:[], changed:[], removed:[] };
  return { baselineAvailable:true, added:Object.keys(current).filter(k=>!previous[k]).sort(), changed:Object.keys(current).filter(k=>previous[k]&&previous[k]!==current[k]).sort(), removed:Object.keys(previous).filter(k=>!current[k]).sort() };
}
export async function prepareRelease(platform, directory, gameSlug, dockerProject) {
  if (!isAbsolute(directory)) throw new Error('Project directory must be absolute');
  const root = await realpath(directory), projectId = projectIdOf(root);
  // The game for this project: the named one only when it belongs to this project; otherwise the one
  // the project matches (GitHub repository, play address, local upload). Several: the creator picks.
  if (!dockerProject) {
    const found = await findMyGame(platform, directory, gameSlug);
    if (found.error) return found;
    if (!gameSlug && found.matches?.length > 1) return { ...found, code: 'CHOOSE_GAME' };
    gameSlug = gameSlug ?? found.gameSlug;
  }
  const params = new URLSearchParams(gameSlug ? {slug:gameSlug} : dockerProject ? {dockerProject} : {projectId});
  const context = await platform.request('/api/publish/releases/context?'+params);
  if(context.error)return context;
  // Files are walked and hashed only when the last release kept a file list to compare with: never for
  // link games (compared with git) and never for a first release, which has nothing to compare.
  const head = await gitHead(root), manifest = context.previous?.source_manifest;
  const comparison = context.source === 'external' ? await compareCommits(root, context.previous?.source_commit, head)
    : manifest && Object.keys(manifest).length ? compareSources(manifest, (await sourceSnapshot(root)).sourceFiles) : compareSources(null, {});
  // How this game is published decides the update route (GitHub rebuild, local upload, link, Docker).
  return { ...context, ...updateRoute(context), previous: context.previous ? {...context.previous,source_manifest:undefined}:null,
    comparison,
    ...(head?{sourceCommit:head}:{}),
    instructions:`${comparison.method==='git'?(comparison.baselineAvailable?'This link game is compared with git: comparison lists files changed since the commit of the last link publication and comparison.log its commit messages; edits not yet committed are not included. ':'No git baseline for this link game (not a repository, or the last link publication kept no commit): publish as usual. '):''}Read the changed local files to understand gameplay, levels, balance, fixes, UX and assets. File names alone do not establish major/minor changes. Use major for substantial redesign/save incompatibility, minor for new gameplay or levels, patch for fixes/balance, assets for resource-only changes (patch increment). Start at 1.0.0. Choose the corresponding suggested version and write concise player-facing notes by relevant area. If no baseline exists, inspect actual code and describe only verified changes; never invent a comparison. Before actual publication, obtain and reuse the logical updateId from prepare_game. Then follow channel/nextSteps: supply release {updateId,version,title,notes,changeType} to the matching tool (update_github_game, publish_game, publish_link or publish_docker_game); the platform attaches notes to the private build history; a successful update deployment alone never writes its public version record. ${updateApprovalGuidance.en} ${updateHistoryGuidance.en}` };
}
