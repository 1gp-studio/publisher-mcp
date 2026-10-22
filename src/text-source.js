// Author-owned source configuration only. Scanning never deploys a game or verifies its renderer.
const locales = ['zh', 'en', 'ja', 'ko', 'es'];
const phraseId = /^p\.[a-f0-9]{64}$/;
const fail = (code, error) => ({ code, error });
function endpoint(slug, use) {
  if (typeof slug !== 'string' || slug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !['keys', 'phrases'].includes(use)) throw new Error('Invalid game slug or text use');
  return '/api/developer/text-source/' + encodeURIComponent(slug) + '?use=' + use;
}
const configFields = ['enabled', 'locale', 'files', 'excluded', 'revision', 'last_result', 'last_error', 'pending_entries', 'warnings', 'last_checked_at', 'last_synced_at', 'source_fingerprint'];
function snapshot(data) {
  if (data?.error) return fail(typeof data.code === 'string' ? data.code : 'TEXT_SOURCE_UNAVAILABLE', String(data.error));
  const config = data?.config;
  if (!data || !Object.hasOwn(data, 'config') || !Array.isArray(data.status) || !Object.hasOwn(data, 'engine')
    || !data.integration || typeof data.integration.state !== 'string' || typeof data.integration.message !== 'string'
    || config !== null && (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean' || !locales.includes(config.locale)
      || !Array.isArray(config.files) || !Number.isSafeInteger(config.revision) || config.revision < 1))
    return fail('TEXT_SOURCE_UNAVAILABLE', '自动文字来源状态不可用，请恢复读取后继续；不能当作未配置。');
  // Do not forward private lease fields even if a server accidentally includes them.
  return { config: config === null ? null : Object.fromEntries(configFields.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]])),
    engine: data.engine, status: data.status,
    ...(data.engine === null ? { translationNotice: '平台翻译服务未启用；同步原文不会生成译文，需宿主 AI 补齐后上传。' } : {}),
    ...(data.scan && typeof data.scan === 'object' ? { scan: {
      ...Object.fromEntries(['scanned', 'synced', 'review', 'failed', 'superseded'].filter(key => Number.isSafeInteger(data.scan[key]) && data.scan[key] >= 0).map(key => [key, data.scan[key]])),
      ...(typeof data.scan.queued === 'boolean' ? { queued: data.scan.queued } : {}),
      ...(['partial', 'complete'].includes(data.scan.status) ? { status: data.scan.status } : {}),
    } } : {}),
    integration: Object.fromEntries(['state', 'message', 'key_mode', 'source_mode', 'source_synced'].filter(key => Object.hasOwn(data.integration, key)).map(key => [key, data.integration[key]])) };
}
async function request(platform, path, options) {
  try { return snapshot(await platform.request(path, options)); }
  catch { return fail('TEXT_SOURCE_UNAVAILABLE', '自动文字来源请求结果不明，请重新读取状态；不要重复发布游戏。'); }
}
async function account(platform) {
  const token = typeof platform.token === 'function' ? await platform.token() : null;
  if (typeof platform.token === 'function' && !token) return { error: fail('AUTH_REQUIRED', '请先连接平台。') };
  const client = Object.create(platform);
  if (token) client.request = (path, options = {}) => platform.request(path, { ...options, token });
  return { client, changed: async () => Boolean(token && await platform.token() !== token) };
}
const changedAccount = () => fail('ACCOUNT_CHANGED', '连接账号已变更，请使用原账号重新读取配置；不会向新账号重放修改。');
export async function getGameTextSource(platform, slug, use = 'keys') {
  const path = endpoint(slug, use), scope = await account(platform);
  if (scope.error) return scope.error;
  const result = await request(scope.client, path);
  return await scope.changed() ? changedAccount() : result;
}
function validate(options, use) {
  if (typeof options.enabled !== 'boolean' || !locales.includes(options.locale) || !Array.isArray(options.files)
    || !options.files.length || options.files.length > (use === 'keys' ? 1 : 16) || new Set(options.files).size !== options.files.length
    || options.files.some(file => typeof file !== 'string' || file.length > 300 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(file)
      || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')
      || !(use === 'keys' ? /\.json$/i : /\.(?:html?|m?js|pck)$/i).test(file))
    || options.excluded !== undefined && (!Array.isArray(options.excluded) || options.excluded.length > 2000 || new Set(options.excluded).size !== options.excluded.length
      || options.excluded.some(key => !phraseId.test(key)) || use === 'keys' && options.excluded.length)
    || options.scan !== undefined && typeof options.scan !== 'boolean') throw new Error('Invalid text source configuration');
}
export async function configureGameTextSource(platform, slug, { use = 'keys', scan = true, ...options }) {
  const path = endpoint(slug, use); validate({ ...options, scan }, use);
  const scope = await account(platform); if (scope.error) return scope.error;
  const current = await request(scope.client, path);
  if (await scope.changed()) return changedAccount();
  if (current.error) return current;
  // Omitting exclusions preserves the author's existing decisions.
  const body = { enabled: options.enabled, locale: options.locale, files: options.files,
    excluded: options.excluded ?? current.config?.excluded ?? [], expectedRevision: current.config?.revision ?? 0 };
  const saved = await request(scope.client, path, { method: 'PUT', body });
  if (await scope.changed()) return changedAccount();
  if (saved.error) return saved;
  if (!saved.config || saved.config.revision < body.expectedRevision || saved.config.enabled !== body.enabled
    || saved.config.locale !== body.locale || JSON.stringify(saved.config.files) !== JSON.stringify(body.files)
    || JSON.stringify(saved.config.excluded ?? []) !== JSON.stringify(body.excluded))
    return fail('TEXT_SOURCE_UNCONFIRMED', '服务器未确认本次配置，请重新读取；尚不能宣称已保存。');
  if (!scan || !body.enabled) return saved;
  const scanned = await request(scope.client, path, { method: 'POST', body: { action: 'scan' } });
  if (await scope.changed()) return changedAccount();
  if (!scanned.error && scanned.scan?.superseded > 0)
    return { ...scanned, ...fail('SOURCE_CHANGED', '配置已保存，但扫描期间来源或词表已改变，本次扫描结果未确认应用；请重新读取状态。'), configurationSaved: true };
  if (!scanned.error && (scanned.scan?.failed > 0 || scanned.config?.last_result === 'failed'))
    return { ...scanned, ...fail('TEXT_SOURCE_SCAN_FAILED', '配置已保存，但来源扫描失败，请检查 last_error 后再检查更新。'), configurationSaved: true };
  return scanned.error ? { ...scanned, configurationSaved: true, config: saved.config, integration: saved.integration } : scanned;
}
export async function approveGameTextCandidates(platform, slug, { keys, expectedRevision, expectedFingerprint }) {
  const path = endpoint(slug, 'phrases');
  if (!Array.isArray(keys) || !keys.length || keys.length > 2000 || keys.some(key => !phraseId.test(key)) || new Set(keys).size !== keys.length
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !/^[a-f0-9]{64}$/.test(expectedFingerprint ?? '')) throw new Error('Invalid candidate approval snapshot');
  const scope = await account(platform); if (scope.error) return scope.error;
  const current = await request(scope.client, path);
  if (await scope.changed()) return changedAccount();
  if (current.error) return current;
  if (current.config?.revision !== expectedRevision || current.config.source_fingerprint !== expectedFingerprint)
    return fail('SOURCE_CHANGED', '来源快照已改变，请重新审查待确认条目；不会自动批准新的内容。');
  const result = await request(scope.client, path, { method: 'POST', body: { action: 'approve', keys, expectedRevision, expectedFingerprint } });
  return await scope.changed() ? changedAccount() : result;
}
