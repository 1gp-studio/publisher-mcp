import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
const exec = promisify(execFile);

// How each publishing channel is updated (prepare_release returns this as channel/nextSteps).
export function updateRoute(context) {
  switch (context?.source) {
    case 'github': return { channel: 'github', nextSteps: [
      `这个游戏从 GitHub 仓库 ${context.repo ?? ''} 发布：保持 GitHub 渠道，不要改成本地上传。`,
      '把改动提交并推送到这个仓库的发布分支（已有本次提交推送授权时直接执行；缺少授权时集中说明要推送的提交并询问，不要强推或改写历史）。',
      '然后调用 update_github_game（附上 release 版本说明），平台从最新提交重新构建；用 wait_for_publish 等到 ready 或 failed。',
    ] };
    case 'external': return { channel: 'external', nextSteps: [
      `这个游戏是外部链接（${context.playUrl ?? '作者自己的托管'}）：平台不托管它的文件。`,
      '只上传或修改语言文件（upload_game_text）、各语言游戏名和简介（set_game_details）时：译文运行时从平台读取，上传完就生效，不用发新版本，也不用去开发者中心点「发新版本」。',
      '改了游戏代码时：请作者先在自己的托管处更新游戏，再用 publish_link（同一网址）附上 release 版本说明，更新游戏页信息。',
    ] };
    case 'docker': return { channel: 'docker', nextSteps: [
      `这个游戏用 1GP Docker 发布（project: ${context.dockerProject ?? ''}）：沿用 build_docker_image → upload_docker_image → get_docker_upload_status → publish_docker_game，project 保持不变。`,
    ] };
    case 'local': return { channel: 'local', nextSteps: ['这个游戏从本地上传：复用 prepare_game 的 inspection（没有时才 inspect_game），需要时 build_vercel_game，再 publish_game；带上 gameSlug、release 和已有产物参数，不重复构建。'] };
    default: return { channel: 'new', nextSteps: ['还没有发布过：复用 prepare_game 的 inspection 选择合适的发布方式；没有检查结果时才调用 inspect_game。'] };
  }
}

const git = async (directory, args) => (await exec('git', ['-C', directory, ...args], { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const repoOf = url => url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1]?.toLowerCase();

// A GitHub game: check that this folder is that repository and the work is on GitHub, then ask the
// platform to rebuild from the branch it publishes. Never pushes; says what to push instead.
export async function updateGithubGame(platform, projectDirectory, gameSlug, release) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let directory;
  try { directory = await realpath(resolve(projectDirectory)); } catch { return { error: '无法读取项目目录。' }; }
  const context = await platform.request(`/api/publish/releases/context?${new URLSearchParams({ slug: gameSlug })}`);
  if (context.error) return context;
  if (context.source !== 'github') return { error: '这个游戏不是从 GitHub 发布的。', code: 'NOT_GITHUB', ...updateRoute(context) };
  const expected = String(context.repo ?? '').toLowerCase();
  let remotes;
  try { remotes = (await git(directory, ['remote', '-v'])).split('\n'); } catch { return { error: '这个文件夹不是 git 仓库，无法确认它就是游戏的 GitHub 仓库。', code: 'NOT_A_REPOSITORY' }; }
  const remote = remotes.map(line => line.split(/\s+/)).find(([, url]) => repoOf(url ?? '') === expected)?.[0];
  if (!remote) return { error: `这个文件夹的远程仓库不是 ${expected}。请在游戏的仓库里操作。`, code: 'OTHER_REPOSITORY' };
  const branchInfo = await platform.request(`/api/games/${encodeURIComponent(gameSlug)}/build`);
  const branch = typeof branchInfo.branch === 'string' && branchInfo.branch ? branchInfo.branch : null;
  if (!branch) return { error: branchInfo.error ?? '读不到这个游戏发布用的分支。', code: 'BRANCH_UNKNOWN' };
  const dirty = await git(directory, ['status', '--porcelain', '--untracked-files=no']).catch(() => '');
  if (dirty) return { error: '有还没提交的改动。按已有授权提交并推送；尚未授权时再询问。', code: 'UNCOMMITTED_CHANGES', branch, files: dirty.split('\n').slice(0, 20) };
  try { await git(directory, ['fetch', '--quiet', remote, branch]); } catch { return { error: `无法从 ${remote} 读取分支 ${branch}（网络或权限问题）。`, code: 'FETCH_FAILED', branch }; }
  const head = await git(directory, ['rev-parse', 'HEAD']);
  const remoteHead = await git(directory, ['rev-parse', `${remote}/${branch}`]).catch(() => '');
  const onRemote = remoteHead && await git(directory, ['merge-base', '--is-ancestor', head, `${remote}/${branch}`]).then(() => true, () => false);
  if (!onRemote) {
    const ahead = await git(directory, ['log', '--oneline', `${remote}/${branch}..HEAD`]).catch(() => '');
    return { error: `本地的提交还没在 GitHub 的 ${branch} 分支上。核对这些提交并按已有授权推送；缺少授权时先询问。目标： ${remote} ${branch}（不要强推），再调用 update_github_game。`, code: 'NOT_PUSHED', branch, commits: ahead.split('\n').filter(Boolean).slice(0, 20) };
  }
  const result = await platform.request(`/api/games/${encodeURIComponent(gameSlug)}/build`, { body: { kind: 'branch', value: branch, ...(release ? { release } : {}) } });
  if (result.error) return result;
  return { ...result, branch, commit: remoteHead, message: '已从 GitHub 最新提交开始构建。用 get_publish_status 等到 ready 或 failed，不要重复提交。' };
}
