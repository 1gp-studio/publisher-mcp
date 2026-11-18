import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCommits, gitHead, prepareRelease } from '../src/releases.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'link-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function commit(dir, files, message) {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) { git(dir, 'rm', '-q', name); continue; }
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
    git(dir, 'add', name);
  }
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

test('a link game compares with git: files changed since the last publication and their commit messages', async t => {
  const repo = await folder(t);
  git(repo, 'init', '-q');
  // The game sits in a subfolder of a larger repository; paths and commits stay within it.
  const first = await commit(repo, { 'game/main.gd': 'v1', 'game/old.gd': 'old', 'game/1gp-kit/game.json': '{}', 'other/readme.md': 'x' }, 'First');
  await commit(repo, { 'game/main.gd': 'v2', 'game/level 2.tscn': 'new', 'game/old.gd': null, 'game/1gp-kit/game.json': '{"a":1}' }, 'Add level 2');
  await commit(repo, { 'other/readme.md': 'y' }, 'Outside the game');
  const head = await commit(repo, { 'game/main.gd': 'v3' }, 'Faster jumps');
  const game = join(repo, 'game');
  assert.equal(await gitHead(game), head);
  const result = await compareCommits(game, first, head);
  assert.deepEqual({ ...result, log: result.log.map(line => line.replace(/^\w+ /, '')) },
    { baselineAvailable: true, method: 'git', from: first, to: head, added: ['level 2.tscn'], changed: ['main.gd'], removed: ['old.gd'], log: ['Faster jumps', 'Add level 2'] });
  assert.deepEqual(await compareCommits(game, head, head), { baselineAvailable: true, method: 'git', from: head, to: head, added: [], changed: [], removed: [], log: [] });
});

test('without git information a link game has no baseline and still publishes', async t => {
  const none = { baselineAvailable: false, method: 'git', added: [], changed: [], removed: [] };
  const repo = await folder(t);
  git(repo, 'init', '-q');
  const head = await commit(repo, { 'index.html': 'x' }, 'Only');
  assert.deepEqual(await compareCommits(repo, undefined, head), none, 'the last publication kept no commit');
  assert.deepEqual(await compareCommits(repo, 'b'.repeat(40), head), none, 'a commit this repository does not have');
  assert.deepEqual(await compareCommits(repo, 'not a commit; rm -rf /', head), none);
  const plain = await folder(t);
  assert.equal(await gitHead(plain), undefined);
  assert.deepEqual(await compareCommits(plain, head, undefined), none, 'not a repository');
});

test('preparing a link game or a first release never walks and hashes the project files', async t => {
  const repo = await folder(t);
  git(repo, 'init', '-q');
  // Over the 1000-file comparison limit: walking these files would fail the preparation.
  for (let index = 0; index < 1001; index += 1) await writeFile(join(repo, `asset-${index}.txt`), String(index));
  const first = await commit(repo, { 'index.html': 'v1' }, 'First');
  const head = await commit(repo, { 'index.html': 'v2' }, 'Second');
  const platform = context => ({ request: async () => context });
  const link = await prepareRelease(platform({ source: 'external', playUrl: 'https://example.org/play', previous: { release_version: '1.0.0', source_commit: first }, suggested: { patch: '1.0.1' } }), repo);
  assert.equal(link.channel, 'external');
  assert.deepEqual([link.comparison.method, link.comparison.baselineAvailable, link.comparison.changed, link.sourceCommit], ['git', true, ['index.html'], head]);
  assert.match(link.instructions, /compared with git/);
  const unrecorded = await prepareRelease(platform({ source: 'external', playUrl: 'https://example.org/play', previous: { release_version: '1.0.0' }, suggested: { patch: '1.0.1' } }), repo);
  assert.equal(unrecorded.comparison.baselineAvailable, false);
  assert.match(unrecorded.instructions, /publish as usual/);
  const fresh = await prepareRelease(platform({ previous: null, suggested: { patch: '1.0.0' } }), repo);
  assert.deepEqual([fresh.comparison.baselineAvailable, fresh.sourceCommit], [false, head]);
  // A local game with a file list from its last release is still compared file by file.
  await assert.rejects(prepareRelease(platform({ source: 'local', previous: { source_manifest: { 'index.html': 'a'.repeat(64) } }, suggested: { patch: '1.0.1' } }), repo), /1000 source files/);
});
