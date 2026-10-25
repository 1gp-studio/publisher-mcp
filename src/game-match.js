import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
const exec = promisify(execFile);

// What identifies the current project on AIWANNA: its GitHub repositories, where it may be played
// (GitHub Pages from those repositories, package.json homepage, a CNAME file) and its local-upload id.
async function small(path) { try { const stat = await lstat(path); return stat.isFile() && stat.size < 100000 ? await readFile(path, 'utf8') : null; } catch { return null; } }
export async function projectSignals(projectDirectory) {
  const directory = await realpath(resolve(projectDirectory));
  const repos = new Set(), urls = new Set();
  try {
    const { stdout } = await exec('git', ['-C', directory, 'remote', '-v'], { timeout: 10000, maxBuffer: 65536 });
    for (const match of stdout.matchAll(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s/gi)) repos.add(`${match[1]}/${match[2]}`.toLowerCase());
  } catch { /* Not a git repository. */ }
  for (const repo of repos) {
    const [owner, name] = repo.split('/');
    urls.add(name === `${owner}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`);
  }
  try { const homepage = JSON.parse(await small(join(directory, 'package.json')) ?? '{}').homepage; if (typeof homepage === 'string' && /^https:\/\//.test(homepage)) urls.add(homepage); } catch { /* No package.json. */ }
  for (const name of ['CNAME', 'public/CNAME', 'docs/CNAME']) { const host = (await small(join(directory, name)))?.trim(); if (host && /^[\w.-]+\.[a-z]{2,}$/i.test(host)) urls.add(`https://${host}/`); }
  return { repos: [...repos], urls: [...urls], projectId: createHash('sha256').update(directory).digest('hex').slice(0, 32) };
}

// The creator's own game for this project: one match is used, several are listed for the creator to
// pick, none means a new game. A named game that belongs to another project is refused.
export async function findMyGame(platform, projectDirectory, gameSlug) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let signals;
  try { signals = await projectSignals(projectDirectory); } catch { return { error: '无法读取项目目录。' }; }
  const result = await platform.request('/api/developer/games/match', { body: { ...signals, ...(gameSlug ? { slug: gameSlug } : {}) } });
  if (result.error) return { ...result, project: signals };
  if (gameSlug) return { gameSlug, game: result.game, project: signals };
  const matches = result.matches ?? [];
  if (matches.length === 1) return { gameSlug: matches[0].slug, game: matches[0], project: signals, message: `当前项目就是《${matches[0].title}》（${matches[0].slug}）。` };
  if (matches.length > 1) return { matches, project: signals, message: '当前项目对应好几个游戏：列给用户，让用户选一个，再用它的 slug 继续。' };
  return { matches: [], project: signals, message: '你的游戏里没有和当前项目对应的：这是一个新游戏，用 inspect_game 选择发布方式。如果用户说已经发布过，请他打开那个游戏的页面，确认仓库或网址。' };
}
