// Every version of a hosted game is served from one fixed address, so players keep their browser
// saves across updates. Two things can then keep players on an old version after an update: a
// service worker, and long browser caching of files whose names stay the same between versions.
// Both are reported to the author; neither blocks publishing or changes the game.
const workerName = /(?:^|\/)(?:sw|service[-_.]?worker|[^/]*\.service\.worker|ngsw-worker|registerSW|workbox-[^/]*)\.m?js$/i;
// Build tools put a content hash in file names (index-Bx3kA9qP.js); such files may be cached forever.
const hashedName = path => {
  const token = path.match(/[.-]([A-Za-z0-9_]{8,})\.[A-Za-z0-9]+$/)?.[1];
  return !!token && (/\d/.test(token) || /[a-z]/.test(token) && /[A-Z]/.test(token));
};
const longCache = value => typeof value === 'string' && (/\bimmutable\b/i.test(value) || Number(value.match(/\bmax-age\s*=\s*(\d+)/i)?.[1] ?? 0) >= 3600);

// files: the bundle about to be uploaded, [{file, data (base64)}]; full Vercel output keeps its
// .vercel/output/ prefix. Returns warnings for the publish result and inspection.
export function updateFreshnessWarnings(files) {
  const text = file => Buffer.from(file.data, 'base64').toString('utf8');
  const served = file => file.file.startsWith('.vercel/output/') ? file.file.startsWith('.vercel/output/static/') ? file.file.slice(22) : null : file.file;
  const web = files.map(file => ({ file, path: served(file) })).filter(entry => entry.path !== null);
  const workers = new Set(web.filter(({ path }) => workerName.test(path)).map(({ path }) => path));
  for (const { file, path } of web) {
    if (!/\.(?:html?|m?js)$/i.test(path)) continue;
    const body = text(file);
    // Godot's engine loader always contains registration code; it only runs when the export
    // configures a worker, which index.html then names in GODOT_CONFIG.
    if (/"serviceWorker"\s*:\s*"[^"]+"/.test(body) || /serviceWorker\s*\.\s*register\s*\(/.test(body) && !/installServiceWorker/.test(body)) workers.add(path);
  }
  const warnings = [];
  if (workers.size) warnings.push({ code: 'SERVICE_WORKER', files: [...workers].sort().slice(0, 10),
    message: '游戏用了 service worker。AIWANNA 上每个游戏用固定地址（玩家本地存档跨版本保留），service worker 会在玩家浏览器里一直留着，更新后可能还给玩家旧版本。请告诉作者：确认它在新版本上线时会更新（换缓存名、skipWaiting 等），或者去掉；不要擅自改游戏代码。' });
  const config = files.find(file => file.file === '.vercel/output/config.json');
  let routes = [];
  try { routes = config ? JSON.parse(text(config)).routes ?? [] : []; } catch { routes = []; }
  const cached = [];
  for (const route of Array.isArray(routes) ? routes : []) {
    const headers = route && typeof route === 'object' && route.headers && typeof route.headers === 'object' ? route.headers : null;
    const value = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'cache-control')?.[1];
    if (!longCache(value) || typeof route.src !== 'string') continue;
    let pattern;
    try { pattern = new RegExp(`^(?:${route.src.replace(/^\^/, '').replace(/\$$/, '')})$`); } catch { continue; }
    for (const { path } of web) if (!hashedName(path) && (pattern.test(`/${path}`) || path === 'index.html' && pattern.test('/'))) cached.push(path);
  }
  if (cached.length) warnings.push({ code: 'LONG_CACHE', files: [...new Set(cached)].sort().slice(0, 10),
    message: '这些文件名不带内容指纹，却设置了长缓存（max-age ≥ 1 小时或 immutable）。AIWANNA 上每个游戏用固定地址，更新后玩家浏览器可能继续用旧文件。请告诉作者：缩短这些文件的缓存，或让构建给文件名加内容指纹；不要擅自改游戏代码。' });
  return warnings;
}
