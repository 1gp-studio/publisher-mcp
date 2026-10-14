import { spawn } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { lstat, readFile, realpath, mkdtemp, chmod, rm, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const archiveLimit = 256 * 1024 * 1024;
export const dockerContract = 'Create and review Dockerfile and .dockerignore for the actual game. Build linux/amd64, listen on 0.0.0.0:3000, GET / returns 2xx, explicit non-root USER, no VOLUME. Runtime: 512 MiB RAM, 1 CPU, read-only filesystem, writable /tmp only (64 MiB). Keep persistent data external. Never embed credentials. Docker Desktop must use Linux containers. No AWS CLI, AWS login or registry push is needed.';
// Deliberately strict: Dockerfile-specific ignore files override the root ignore file.
export const requiredIgnores = ['**/.env*', '**/.git', '**/.aws', '**/.ssh', '**/.config', '**/*.pem', '**/*.key'];
export async function dockerProject(directory) {
  if (!isAbsolute(directory)) throw new Error('INVALID_PROJECT: project_directory must be absolute.');
  const root = await realpath(directory);
  for (const name of ['Dockerfile', '.dockerignore']) {
    const stat = await lstat(join(root, name)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 100000) throw new Error(`DOCKER_PREPARATION_REQUIRED: ${name} must be a regular file under 100 KB. ${dockerContract} Required .dockerignore lines: ${requiredIgnores.join(', ')}`);
  }
  if (await lstat(join(root, 'Dockerfile.dockerignore')).catch(() => null)) throw new Error('DOCKER_PREPARATION_REQUIRED: consolidate Dockerfile.dockerignore into .dockerignore before building.');
  const patterns = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (patterns.some(s => s.startsWith('!')) || requiredIgnores.some(s => !patterns.includes(s))) throw new Error(`DOCKER_PREPARATION_REQUIRED: .dockerignore must include ${requiredIgnores.join(', ')} without ! re-inclusions. Review other project-specific secrets too.`);
  return root;
}
export async function runDocker(args, cwd, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    // No shell, build args, secret forwarding, privileged options or user-supplied executable.
    const child = spawn('docker', args, { cwd, shell: false, stdio: 'ignore', detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') child.kill();
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new Error('DOCKER_UNAVAILABLE: install/start Docker with Buildx and Linux containers. Nothing was uploaded.')); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || timedOut) reject(new Error('DOCKER_BUILD_FAILED: Docker failed or timed out. Inspect the local Dockerfile and Docker daemon; no archive was uploaded. Build logs are not returned because they may contain secrets.')); else resolve(); });
  });
}
export async function buildDockerImage(directory, { run = runDocker } = {}) {
  const root = await dockerProject(directory);
  const folder = await realpath(await mkdtemp(join(tmpdir(), '1gp-docker-')));
  await chmod(folder, 0o700);
  const archive = join(folder, 'game-image.tar');
  const tag = `1gp-local:${randomUUID()}`;
  try {
    await run(['buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--load', '--tag', tag, '.'], root);
    await run(['save', '--output', archive, tag], root, 120000);
    const size = await archiveSize(archive);
    await chmod(archive, 0o600);
    return { archive_path: archive, size, platform: 'linux/amd64', next: 'upload_docker_image', message: 'Local archive ready. Upload it with a stable project identifier. The archive stays on disk for retries; remove it after successful import if no longer needed.' };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  } finally { await run(['image', 'rm', tag], root, 15000).catch(() => {}); }
}
export async function archiveSize(path) {
  if (!isAbsolute(path) || !path.endsWith('.tar')) throw new Error('INVALID_ARCHIVE: use an absolute path to a docker save .tar file.');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > archiveLimit) throw new Error('INVALID_ARCHIVE: use a regular, non-symlink .tar archive between 1 KiB and 256 MiB.');
  return stat.size;
}
export function validateUploadTarget(signed) {
  const url = new URL(signed.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^1gp-game-uploads-\d{12}-dev\.s3\.us-east-1\.amazonaws\.com$/.test(url.hostname)) throw new Error('INVALID_UPLOAD_TARGET: platform did not return the expected private upload bucket.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(signed.id) || signed.fields?.key !== `uploads/${signed.id}.tar`) throw new Error('INVALID_UPLOAD_TARGET: invalid upload reference.');
  if (Object.keys(signed.fields).length > 20 || Object.entries(signed.fields).some(([key, value]) => !/^(?:key|bucket|policy|Content-Type|x-amz-[a-z-]+)$/i.test(key) || typeof value !== 'string' || value.length > 20000)) throw new Error('INVALID_UPLOAD_TARGET: invalid upload fields.');
  return url.href;
}
export async function uploadDockerImage(platform, path, project, { send = fetch } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(project)) throw new Error('INVALID_PROJECT: use a stable lowercase project identifier (up to 48 characters).');
  const size = await archiveSize(path);
  const signed = await platform.request('/api/publish/docker/uploads', { body: { project, size } });
  if (signed.error) return signed;
  const url = validateUploadTarget(signed);
  const id = signed.id;
  if (platform.file) {
    const pending = platform.file + '.docker-upload.json';
    const temporary = pending + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify({ upload_id: id, project, archive_path: path }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, pending);
  }
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(signed.fields)) form.append(key, value);
    // openAsBlob streams from disk and detects modification; never load 256 MiB into JSON/base64.
    form.append('file', await openAsBlob(path, { type: 'application/x-tar' }), 'game-image.tar');
    const response = await send(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(240000) });
    if (!response.ok) throw new Error('upload rejected');
    const completed = await platform.request(`/api/publish/docker/uploads/${id}`, { body: {} });
    return { ...completed, upload_id: id, project, next: 'get_docker_upload_status', message: completed.error ? 'Upload sent; completion is uncertain. Resume with get_docker_upload_status; do not upload again.' : completed.message };
  } catch {
    return { error: 'Upload interrupted or rejected. First call get_docker_upload_status with this upload_id to check whether the file arrived. Do not automatically repeat the upload. If no file arrived, the session expires after 20 minutes; keep the local archive for retry.', code: 'UPLOAD_UNCERTAIN', upload_id: id, project };
  }
}
export async function dockerUploadStatus(platform, id) {
  if (!id && platform.file) {
    const path = platform.file + '.docker-upload.json';
    const info = await lstat(path).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink() && info.size < 4096) id = JSON.parse(await readFile(path, 'utf8')).upload_id;
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? '')) throw new Error('UPLOAD_ID_REQUIRED: supply upload_id; no local pending upload was found.');
  // Completion is idempotent and pins the S3 object version. This also recovers a
  // successful transfer whose completion response was lost or whose tool was interrupted.
  const data = await platform.request(`/api/publish/docker/uploads/${id}`);
  if (data.error || data.state !== 'uploading') return { ...data, upload_id: id };
  return { ...await platform.request(`/api/publish/docker/uploads/${id}`, { body: {} }), upload_id: id };
}
