import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedProjectDirectory, readProjectFile } from './media-files.js';

// record_game_video: plays the author's game in the local Chrome / Edge, headless, runs the author's AI's own
// director script inside it and saves a promo video (and optional store screenshots) into the project. The
// tool only records; what to show is the director's choice. Frames are rendered one by one (smooth on any
// machine) and encoded in the page, so nothing else needs installing.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const failure = (code, error, extra = {}) => ({ code, error, ...extra });
const outside = path => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8' };
export const maxVideoBytes = 5 * 1024 * 1024;
const marker = '/*TRAILER_HOOK*/';
// The game and its scripts share this origin: a loopback listener alone does not
// protect project credentials. Serve only browser assets, with the same hidden,
// credential, backend and config exclusions used by the publishing validators.
const privateName = /^(?:\.|node_modules$|api$|server$|credentials|secrets|secret(?:[._-]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i;
const privateFile = /^(?:package(?:-lock)?\.json|(?:tsconfig.*|vercel|now)\.json|.*\.config\.[cm]?[jt]s|server\.[cm]?[jt]s)$/i;
const assetType = /\.(?:[cm]?js|json|html?|css|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|ogg|mp3|wav|m4a|mp4|webm|wasm|glb|gltf|txt|data|bin|atlas|webmanifest|xml|pck|pdf)$/i;
const privateContents = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----|\bsb_secret_[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bvcp_[A-Za-z0-9_]{24,}/;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

async function publicAsset(served, path) {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '..' || privateName.test(part) || privateFile.test(part)) || !assetType.test(path)) return null;
  try {
    const { bytes } = await readProjectFile(served, path, 64 * 1024 * 1024);
    if (/\.(?:[cm]?js|json|html?|css|svg|txt|xml)$/i.test(path) && privateContents.test(bytes.toString('utf8'))) return null;
    return bytes;
  } catch { return null; }
}

function outputPath(project, path, directory = false) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[:\p{Cc}\p{Cf}]/u.test(path) || isAbsolute(path) || win32.isAbsolute(path)) throw new Error('输出必须使用项目内的相对路径。');
  const parts = path.split(/[\\/]/).filter(part => part !== '.');
  if (parts.some(part => !part || part === '..' || /[. ]$/.test(part) || reservedName.test(part))) throw new Error('输出路径包含不安全的文件名。');
  const full = resolve(project, ...parts);
  if (outside(relative(project, full)) || (!directory && full === project)) throw new Error('输出必须在项目目录里。');
  return full;
}

async function outputDirectory(project, directory, create = false) {
  if (outside(relative(project, directory))) throw new Error('输出目录必须在项目目录里。');
  // Revalidate the project itself too: it may have been replaced while the
  // browser was recording, including when the requested output is in '.'.
  if (await checkedProjectDirectory(project) !== project) throw new Error('项目目录在录制期间发生了变化。');
  let current = project;
  // Validate existing ancestors before creating anything; recursive mkdir alone
  // follows a directory junction and would already write outside the project.
  for (const part of relative(project, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info && !create) return;
    if (!info) { await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current); }
    if (!info.isDirectory() || info.isSymbolicLink() || outside(relative(project, await realpath(current)))) throw new Error('输出目录不能经过符号链接或目录联接。');
  }
}

async function outputFile(project, file, create = false) {
  await outputDirectory(project, dirname(file), create);
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || outside(relative(project, await realpath(file))))) throw new Error('输出文件不能是符号链接、硬链接或其他非普通文件。');
}

async function writeOutput(project, file, bytes) {
  await outputFile(project, file, true);
  const temporary = join(dirname(file), `.1gp-record-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await outputFile(project, file);
    // Replacing the directory entry, rather than truncating the target, cannot
    // follow a leaf link that appeared after the last check.
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function screenshotName(value, number) {
  let name = String(value ?? '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || `shot-${number}`;
  if (reservedName.test(name)) name = `shot-${name}`;
  return name;
}

export function findBrowser(env = process.env) {
  const candidates = [env.ONEGP_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return candidates.find(path => path && existsSync(path)) ?? null;
}

// With the marker in the game code, the director runs inside the game's own scope instead of the game loop.
// Without it, the page's animation frames and clock are held (REC.advance steps them) and the director runs
// in the global scope once the page has loaded.
export function recordingPage(html) {
  if (html.includes(marker)) return { mode: 'scope', html: html.replace(marker,
    "if (location.hash === '#rec') fetch('/__director.js').then(r => r.text()).then(t => eval(t)).catch(e => fetch('/__log', { method: 'POST', body: 'ERR ' + (e && e.stack || e) })); else ") };
  const head = '<script>window.__recVirtual = true;</script><script src="/__runtime.js"></script>';
  const tail = "<script>addEventListener('load', () => fetch('/__director.js?global=1').then(r => r.text()).then(t => (0, eval)(t)).catch(e => fetch('/__log', { method: 'POST', body: 'ERR ' + (e && e.stack || e) })));</script>";
  const withHead = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : head + html;
  return { mode: 'page', html: /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>(?![\s\S]*<\/body>)/i, tail + '</body>') : withHead + tail };
}

async function inside(root, path) {
  const full = resolve(root, path);
  if (outside(relative(root, full))) return null;
  try { const real = await realpath(full); return outside(relative(root, real)) ? null : real; } catch { return null; }
}

export async function recordGameVideo({ projectDirectory, director, root = '.', page = 'index.html', size = '1080x1920', out, shotsDirectory = '1gp-kit/screenshots', arg = '',
  timeoutSeconds = 900, browser = findBrowser(), launch = spawn } = {}) {
  if (typeof projectDirectory !== 'string' || !isAbsolute(projectDirectory)) return failure('INVALID_REQUEST', '请提供游戏项目的绝对路径。');
  const project = await checkedProjectDirectory(projectDirectory).catch(() => null);
  if (!project) return failure('INVALID_REQUEST', '找不到游戏项目目录。');
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!match || +match[1] < 64 || +match[2] < 64 || +match[1] > 3840 || +match[2] > 3840) return failure('INVALID_REQUEST', 'size 写成 宽x高，例如 1080x1920，每边 64–3840。');
  const served = await inside(project, root);
  const directorFile = typeof director === 'string' ? await inside(project, director) : null;
  if (!served) return failure('INVALID_REQUEST', 'root 要是项目里的目录（游戏网页所在的文件夹，例如 . 或 dist）。');
  if (!directorFile) return failure('INVALID_REQUEST', 'director 要是项目里的导演脚本文件（相对路径）。');
  const pageFile = await inside(served, page);
  if (!pageFile) return failure('INVALID_REQUEST', `在 ${root} 里找不到 ${page}。`);
  let shotsFolder;
  try {
    shotsFolder = outputPath(project, shotsDirectory, true);
    await outputDirectory(project, shotsFolder);
    for (const target of out === undefined ? ['1gp-kit/preview.mp4', '1gp-kit/preview.webm'] : [out]) {
      const file = outputPath(project, target);
      if (!['.mp4', '.webm'].includes(extname(file).toLowerCase())) throw new Error('out 要是项目里的 .mp4 或 .webm 文件路径。');
      await outputFile(project, file);
    }
  } catch (error) { return failure('INVALID_REQUEST', error.message); }
  const htmlBytes = await publicAsset(served, relative(served, pageFile).split(sep).join('/'));
  if (!htmlBytes) return failure('INVALID_REQUEST', 'page 必须是可公开的普通游戏网页文件，不能包含凭据或经过链接。');
  if (!browser) return failure('BROWSER_REQUIRED', '没有找到 Chrome 或 Edge。装上其中一个后重试，或用环境变量 ONEGP_BROWSER 指向浏览器程序。');
  const html = htmlBytes.toString('utf8');
  const [script, runtime, mp4, webm] = await Promise.all([readFile(directorFile, 'utf8'), readFile(join(here, 'recorder-page.js'), 'utf8'),
    readFile(require.resolve('mp4-muxer'), 'utf8'), readFile(require.resolve('webm-muxer'), 'utf8')]);
  const prepared = recordingPage(html);
  const [width, height] = [+match[1], +match[2]];
  const log = [];
  let result = null;
  for (let attempt = 1, scale = 1; attempt <= 3; attempt++) {
    const take = await recordOnce({ served, pageFile, prepared, script, runtime: `${mp4}\n${webm}\n${runtime}`, width, height, scale, arg, timeoutSeconds, browser, launch, log });
    if (take.error) return { ...take, log: log.slice(-30) };
    result = { ...take, attempt };
    if (take.video.length <= maxVideoBytes) break;
    scale *= 0.85 * maxVideoBytes / take.video.length;   // the same director gives the same frames: record again, smaller
    log.push(`over 5 MB (${take.video.length} bytes), recording again at a lower bitrate`);
  }
  if (result.video.length > maxVideoBytes) return failure('VIDEO_TOO_LARGE', '压了三次还是超过 5 MB：缩短时长或减小 size 后重录。', { bytes: result.video.length, log: log.slice(-30) });
  const extension = result.container === 'webm' ? '.webm' : '.mp4';
  const target = out ?? `1gp-kit/preview${extension}`;
  const outFile = outputPath(project, target);
  if (extname(outFile).toLowerCase() !== extension) return failure('INVALID_REQUEST', `out 要是项目里的 ${extension} 文件路径。`);
  const shots = [];
  try {
    // Recheck after recording: a project watcher or the author may have changed
    // an output path while the browser was running. Validate the whole set first.
    const outputs = result.shots.map(([name, bytes]) => [outputPath(project, relative(project, join(shotsFolder, `${name}.png`))), bytes]);
    await outputFile(project, outFile);
    for (const [file] of outputs) await outputFile(project, file);
    await writeOutput(project, outFile, result.video);
    for (const [file, bytes] of outputs) { await writeOutput(project, file, bytes); shots.push(relative(project, file).split(sep).join('/')); }
  } catch (error) { return failure('INVALID_REQUEST', error.message); }
  return { ok: true, mode: prepared.mode, path: relative(project, outFile).split(sep).join('/'), bytes: result.video.length, frames: result.frames, size: result.size,
    container: result.container, codec: result.codec, audio: result.audio || null, attempts: result.attempt, screenshots: shots, log: log.slice(-30),
    message: '已录好。先自己看一遍（抽几帧或整段播放），确认它能让玩家一看就想玩，再给作者看；作者同意后用 set_game_media 的 preview（已有预览时加 replacePreview）上传，截图用 screenshots 上传。' };
}

async function recordOnce({ served, pageFile, prepared, script, runtime, width, height, scale, arg, timeoutSeconds, browser, launch, log }) {
  const shots = new Map();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const pagePath = '/' + relative(served, pageFile).split(sep).join('/');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body = '', type = 'text/plain; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body); };
    try {
      if (request.method === 'POST') {
        const parts = []; for await (const part of request) parts.push(part);
        const body = Buffer.concat(parts);
        if (url.pathname === '/__log') { const line = body.toString('utf8').slice(0, 2000); log.push(line); if (line.startsWith('ERR')) finish({ error: line }); }
        else if (url.pathname === '/__shot') { const name = screenshotName(url.searchParams.get('name'), shots.size + 1); shots.set(name, body); }
        else if (url.pathname === '/__video') finish({ video: body, container: request.headers['x-container'], codec: request.headers['x-codec'], audio: request.headers['x-audio'],
          frames: Number(request.headers['x-frames']), size: request.headers['x-size'] });
        return send(204);
      }
      if (url.pathname === pagePath) return send(200, prepared.html, 'text/html; charset=utf-8');
      if (url.pathname === '/__runtime.js') return send(200, runtime, 'text/javascript; charset=utf-8');
      if (url.pathname === '/__director.js') return send(200, (prepared.mode === 'scope' ? runtime + '\n' : '') + script, 'text/javascript; charset=utf-8');
      const path = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      const bytes = await publicAsset(served, path);
      if (!bytes) return send(404, 'not found');
      return send(200, bytes, types[extname(path).toLowerCase()] ?? 'application/octet-stream');
    } catch { return send(500, 'error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'aiwanna-rec-'));
  const address = `http://127.0.0.1:${server.address().port}${pagePath}?w=${width}&h=${height}&limit=${maxVideoBytes}&scale=${scale.toFixed(3)}&arg=${encodeURIComponent(arg)}#rec`;
  const child = launch(browser, ['--headless=new', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist', `--user-data-dir=${profile}`, `--window-size=${width},${height + 200}`, address], { stdio: 'ignore' });
  child.on?.('error', error => finish({ error: `浏览器启动失败：${error.message}` }));
  const timer = setTimeout(() => finish({ error: `录制超时（${timeoutSeconds} 秒）：检查导演脚本有没有调用 REC.run，日志里有没有 ERR。` }), timeoutSeconds * 1000);
  const take = await done;
  clearTimeout(timer);
  child.kill?.();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  if (take.error) return failure('RECORDING_FAILED', take.error);
  return { ...take, shots: [...shots] };
}
