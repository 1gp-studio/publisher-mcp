// Keep public-result validation compatible with both official brands and the existing transport.
// Custom installations remain limited to their configured origin; never trust suffix matches.
const officialOrigins = new Set([
  'https://1gp-game-platform.vercel.app',
  'https://www.ai-made.games', 'https://ai-made.games',
  'https://www.aiwanna.games', 'https://aiwanna.games',
]);
export function isPlatformOrigin(origin, configuredOrigin) {
  if (officialOrigins.has(origin)) return true;
  if (typeof origin !== 'string' || origin !== configuredOrigin) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && !url.username && !url.password
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  } catch { return false; }
}
