import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const project = await realpath(projectDirectory).catch(() => null);
  if (!project) return failure('INVALID_REQUEST', '找不到游戏项目目录。');
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!match || +match[1] < 64 || +match[2] < 64 || +match[1] > 3840 || +match[2] > 3840) return failure('INVALID_REQUEST', 'size 写成 宽x高，例如 1080x1920，每边 64–3840。');
  const served = await inside(project, root);
  const directorFile = typeof director === 'string' ? await inside(project, director) : null;
  if (!served) return failure('INVALID_REQUEST', 'root 要是项目里的目录（游戏网页所在的文件夹，例如 . 或 dist）。');
  if (!directorFile) return failure('INVALID_REQUEST', 'director 要是项目里的导演脚本文件（相对路径）。');
  const pageFile = await inside(served, page);
  if (!pageFile) return failure('INVALID_REQUEST', `在 ${root} 里找不到 ${page}。`);
  if (!browser) return failure('BROWSER_REQUIRED', '没有找到 Chrome 或 Edge。装上其中一个后重试，或用环境变量 ONEGP_BROWSER 指向浏览器程序。');
  const [html, script, runtime, mp4, webm] = await Promise.all([readFile(pageFile, 'utf8'), readFile(directorFile, 'utf8'), readFile(join(here, 'recorder-page.js'), 'utf8'),
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
  const outFile = resolve(project, target);
  if (outside(relative(project, outFile)) || ![extension].includes(extname(outFile).toLowerCase())) return failure('INVALID_REQUEST', `out 要是项目里的 ${extension} 文件路径。`);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, result.video);
  const shots = [];
  for (const [name, bytes] of result.shots) {
    const file = resolve(project, shotsDirectory, `${name}.png`);
    if (outside(relative(project, file))) continue;
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
    shots.push(relative(project, file).split(sep).join('/'));
  }
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
        else if (url.pathname === '/__shot') { const name = (url.searchParams.get('name') ?? '').replace(/[^\w.-]+/g, '-').slice(0, 60) || `shot-${shots.size + 1}`; shots.set(name, body); }
        else if (url.pathname === '/__video') finish({ video: body, container: request.headers['x-container'], codec: request.headers['x-codec'], audio: request.headers['x-audio'],
          frames: Number(request.headers['x-frames']), size: request.headers['x-size'] });
        return send(204);
      }
      if (url.pathname === pagePath) return send(200, prepared.html, 'text/html; charset=utf-8');
      if (url.pathname === '/__runtime.js') return send(200, runtime, 'text/javascript; charset=utf-8');
      if (url.pathname === '/__director.js') return send(200, (prepared.mode === 'scope' ? runtime + '\n' : '') + script, 'text/javascript; charset=utf-8');
      const file = await inside(served, decodeURIComponent(url.pathname.slice(1)) || 'index.html');
      if (!file || !(await stat(file)).isFile()) return send(404, 'not found');
      return send(200, await readFile(file), types[extname(file).toLowerCase()] ?? 'application/octet-stream');
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
