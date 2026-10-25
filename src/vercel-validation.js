// Generated from lib/publishing/vercel-output.ts; keep the platform and MCP validation contract in sync.
import { createHash } from 'node:crypto';

/** The supported Build Output API v3 subset is deliberately smaller than Vercel's API. */
export const VERCEL_OUTPUT_LIMITS = {
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  configBytes: 100 * 1024,
  files: 10000,
}         ;

const ROOT = '.vercel/output/';
const CONFIG = `${ROOT}config.json`;
const STATIC = `${ROOT}static/`;
const FUNCTIONS = `${ROOT}functions/`;
                                          
                                                                                  
                                                                                                  

function fail(message        )        {
  throw new Error(`UNSUPPORTED_BUILD: ${message}`);
}

function object(value         , label        )             {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是 JSON 对象。`);
  return value              ;
}

function keys(value            , allowed                   , label        ) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} 不支持字段 ${key}；请生成仅含静态资源、同源路由和自包含 Node.js 22/24 函数的产物，或使用 AIWANNA Docker 渠道。`);
  }
}

function boundedString(value         , max        , label        )         {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} 无效。`);
  return value;
}

function relativePath(value         , label        )         {
  const path = boundedString(value, 1024, label);
  if (/[\\%?#:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail(`${label} 必须是安全的相对路径，不能包含路径穿越或编码路径。`);
  return path;
}

const forbiddenNames = /^(?:\.env(?:$|[.-])|\.git(?:$|ignore$|modules$)|\.svn$|\.hg$|\.aws$|\.ssh$|\.config$|\.npmrc$|\.yarnrc(?:\.yml)?$|\.netrc$|\.DS_Store$|credentials(?:[.-]|$)|secrets?(?:[.-]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i;
const secretContents = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----|\bsb_secret_[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bvcp_[A-Za-z0-9_]{24,}/;
const staticTypes = /\.(?:[cm]?js|json|html?|css|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|ogg|mp3|wav|mp4|webm|wasm|glb|gltf|txt|data|bin|atlas|webmanifest|xml|pck|pdf)$/i;

                                                                                                                               

function locateFile(path        )               {
  relativePath(path, '产物路径');
  if (!path.startsWith(ROOT)) fail('完整部署产物路径必须保留 .vercel/output/ 前缀。');
  const parts = path.slice(ROOT.length).split('/');
  if (parts.some(part => forbiddenNames.test(part) || /\.(?:pem|key|p12|pfx|map)$/i.test(part))) fail('部署产物不能包含凭据、私钥、版本管理文件或 source map。');
  if (path === CONFIG) return { kind: 'config', config: true };
  if (path.startsWith(STATIC)) {
    const local = path.slice(STATIC.length);
    const names = local.split('/');
    if (names.some((part, index) => part.endsWith('.func') || part === 'node_modules' || (part.startsWith('.') && !(index === 0 && part === '.well-known')))
      || /(?:^|\/)(?:package(?:-lock)?\.json|(?:tsconfig[^/]*|vercel|now)\.json|[^/]*\.config\.[cm]?[jt]s)$/i.test(local)
      || (!staticTypes.test(local) && !(names[0] === '.well-known' && names.length > 1))) {
      fail('static 目录只能包含浏览器资源，不能包含函数源码目录、依赖或项目配置。');
    }
    return { kind: 'static' };
  }
  if (path.startsWith(FUNCTIONS)) {
    const local = path.slice(FUNCTIONS.length).split('/');
    const index = local.findIndex(part => part.endsWith('.func'));
    if (index < 0 || index === local.length - 1 || local.slice(index + 1).some(part => part.endsWith('.func'))) {
      fail('functions 只支持自包含的 <名称>.func/ 目录；prerender、Edge、services 和 daemons 尚未接入，请使用受支持的 Node.js 函数或 AIWANNA Docker 渠道。');
    }
    const functionName = local.slice(0, index + 1).join('/').slice(0, -5);
    if (!functionName || local.slice(0, index + 1).some(part => part.startsWith('.'))) fail('函数名称无效。');
    const tail = local.slice(index + 1);
    if (tail.some((part, child) => part.startsWith('.') && !['.next', '.pnpm'].includes(part) && !(child === 0 && tail.length === 1 && part === '.vc-config.json'))) fail('函数产物包含不支持的隐藏文件；只保留实际运行所需文件。');
    const functionRoot = `${FUNCTIONS}${local.slice(0, index + 1).join('/')}/`;
    return { kind: 'function', functionName, functionRoot, config: tail.length === 1 && tail[0] === '.vc-config.json' };
  }
  fail('只上传 .vercel/output/config.json、static/ 和 functions/；请移除构建日志、缓存和其他输出，或改用 AIWANNA Docker 渠道。');
}

function parseConfig(bytes        , label        )             {
  if (bytes.length > VERCEL_OUTPUT_LIMITS.configBytes) fail(`${label} 不得超过 100 KiB。`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(`${label} 必须使用有效 UTF-8。`);
  let value         ;
  try { value = JSON.parse(text); } catch { fail(`${label} 必须是有效 JSON。`); }
  return object(value, label);
}

/** Run before staging each file. A manifest cannot rescan content represented only by a hash. */
export function validateVercelOutputFile(path        , input                     )       {
  const location = locateFile(path);
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > VERCEL_OUTPUT_LIMITS.fileBytes) fail('单个完整部署产物不得超过 16 MiB。');
  const text = bytes.toString('utf8');
  if (secretContents.test(text)) fail('部署产物疑似含有凭据或私钥，请移除后重新构建。');
  if (/sourceMappingURL\s*=\s*data:/i.test(text)) fail('部署产物不能包含内联 source map；请关闭 source map 后重新构建。');
  if (location.config) {
    const config = parseConfig(bytes, path);
    if (location.kind === 'config') validateOutputConfig(config);
    else validateFunctionConfig(config);
  }
}

function optionalBoolean(config            , key        , label        ) {
  if (config[key] !== undefined && typeof config[key] !== 'boolean') fail(`${label}.${key} 必须是布尔值。`);
}

function optionalInteger(config            , key        , min        , max        , label        ) {
  if (config[key] !== undefined && (!Number.isInteger(config[key]) || (config[key]          ) < min || (config[key]          ) > max)) fail(`${label}.${key} 必须在 ${min}–${max} 之间。`);
}

function validateFunctionConfig(config            )         {
  if ('env' in config || 'envVarsInUse' in config) fail('函数配置不能携带 env/envVarsInUse；不要将凭据放进发布包。');
  // The official Node builder serializes environment: {} even without variables.
  if ('environment' in config && Object.keys(object(config.environment, '函数 environment')).length) fail('函数配置不能携带非空 environment；不要将凭据放进发布包。');
  // An empty value is the official builder's default Node invocation contract.
  if ('awsLambdaHandler' in config && config.awsLambdaHandler !== '') fail('函数 awsLambdaHandler 只支持空字符串；请使用标准 Node.js 或 Web API 函数入口。');
  if (config.filePathMap !== undefined && Object.keys(object(config.filePathMap, 'filePathMap')).length) fail('函数 filePathMap 引用了产物外文件；请生成自包含产物（例如使用构建器的 standalone 模式），不要仅上传部分文件。');
  if (!['nodejs22.x', 'nodejs24.x'].includes(String(config.runtime))) fail('AIWANNA 完整产物目前支持 Node.js 22/24 函数；Edge、其他运行时和常驻服务请使用受支持构建方式或 AIWANNA Docker 渠道。');
  keys(config, ['runtime', 'handler', 'launcherType', 'memory', 'maxDuration', 'regions', 'architecture', 'shouldAddHelpers', 'shouldAddSourcemapSupport', 'supportsResponseStreaming', 'supportsMultiPayloads', 'filePathMap', 'environment', 'awsLambdaHandler', 'useWebApi'], '函数配置');
  if (config.launcherType !== 'Nodejs') fail('Node.js 函数配置需要 launcherType: "Nodejs"。');
  const handler = relativePath(config.handler, '函数 handler');
  if (!/\.[cm]?js$/i.test(handler)) fail('函数 handler 必须是编译后的 .js、.mjs 或 .cjs 文件。');
  optionalInteger(config, 'memory', 128, 2048, '函数配置');
  optionalInteger(config, 'maxDuration', 1, 300, '函数配置');
  for (const key of ['shouldAddHelpers', 'shouldAddSourcemapSupport', 'supportsResponseStreaming', 'supportsMultiPayloads', 'useWebApi']) optionalBoolean(config, key, '函数配置');
  if (config.architecture !== undefined && config.architecture !== 'x86_64') fail('当前函数产物只支持 Linux x86_64；请使用相应目标平台重新构建。');
  if (config.regions !== undefined && (!Array.isArray(config.regions) || config.regions.length !== 1 || !/^[a-z]{3}[1-9]$/.test(String(config.regions[0])))) fail('函数 regions 只能指定一个有效 Vercel 区域。');
  return handler;
}

/** Destinations are URLs on this isolated deployment, never another host or a file-system path. */
function localUrl(value         , label        )         {
  const url = boundedString(value, 2048, label);
  const path = url.split('?')[0];
  if (!url.startsWith('/') || url.startsWith('//') || /[\\%#\s]/.test(url) || /[:$]/.test(path) || path.split('/').some(part => part === '.' || part === '..' || part.startsWith('.') || part.endsWith('.func') || part === 'node_modules') || /\.(?:map|pem|key)$/i.test(path)) fail(`${label} 只支持固定的同源路径；不能代理到外部主机、平台、云 metadata 或内部产物目录。可将路由捕获变量放在查询参数中。`);
  return url;
}

                                                                                                                                             
const routeHandlers = ['filesystem', 'miss', 'hit', 'error', 'rewrite', 'resource'];

function validateRoute(input         )                                   {
  const route = object(input, 'route');
  if ('handle' in route) {
    keys(route, ['handle'], 'handler route');
    if (!routeHandlers.includes(String(route.handle))) fail('不支持该 route handle。');
    return route                      ;
  }
  keys(route, ['src', 'dest', 'headers', 'methods', 'continue', 'caseSensitive', 'check', 'status'], 'route');
  const src = boundedString(route.src, 1024, 'route.src');
  if (!(src.startsWith('/') || src.startsWith('^/'))) fail('route.src 必须匹配以 / 开始的本地路径。');
  // Compile for syntax checking, but never execute an uploader's expression in this process.
  try { new RegExp(src); } catch { fail('route.src 必须是有效的路由正则表达式。'); }
  if (route.dest !== undefined) localUrl(route.dest, 'route.dest');
  optionalInteger(route, 'status', 200, 599, 'route');
  for (const key of ['continue', 'caseSensitive', 'check']) optionalBoolean(route, key, 'route');
  if (route.methods !== undefined && (!Array.isArray(route.methods) || !route.methods.length || route.methods.length > 9 || route.methods.some(method => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(String(method))))) fail('route.methods 必须是有效 HTTP 方法数组。');
  if (route.headers !== undefined) {
    const headers = object(route.headers, 'route.headers');
    if (Object.keys(headers).length > 32) fail('每条路由最多包含 32 个响应头。');
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || /^(?:authorization|proxy-authorization|cookie|set-cookie|host|connection|transfer-encoding|x-middleware-.+|x-vercel-.+|x-now-.+)$/i.test(name)) fail('路由不能覆盖认证、内部代理或平台控制响应头。');
      boundedString(value, 4096, '响应头');
      if (name.toLowerCase() === 'location') localUrl(value, 'Location');
    }
  }
  return route               ;
}

function validateOutputConfig(config            ) {
  if (config.version !== 3) fail('完整部署产物需要 config.json 的 version: 3。');
  keys(config, ['version', 'routes', 'overrides', 'framework', 'cache'], 'Build Output config');
  if (config.cache !== undefined && (!Array.isArray(config.cache) || config.cache.length)) fail('预构建发布不接受 cache 文件引用，请移除 cache 配置并只上传运行产物。');
  if (config.framework !== undefined) {
    const framework = object(config.framework, 'framework');
    keys(framework, ['slug', 'version'], 'framework');
    boundedString(framework.slug, 80, 'framework.slug');
    if (framework.version !== undefined) boundedString(framework.version, 80, 'framework.version');
  }
  if (config.routes !== undefined) {
    if (!Array.isArray(config.routes) || config.routes.length > 512) fail('routes 必须是最多 512 条路由的数组。');
    config.routes.forEach(validateRoute);
  }
  if (config.overrides !== undefined) {
    const overrides = object(config.overrides, 'overrides');
    if (Object.keys(overrides).length > VERCEL_OUTPUT_LIMITS.files) fail('overrides 数量过多。');
    for (const [file, value] of Object.entries(overrides)) {
      locateFile(`${STATIC}${relativePath(file, 'override 文件')}`);
      const override = object(value, 'override');
      keys(override, ['path', 'contentType'], 'override');
      if (override.path !== undefined) {
        const path = relativePath(override.path, 'override.path');
        localUrl(`/${path}`, 'override.path');
      }
      if (override.contentType !== undefined && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; ?charset=[A-Za-z0-9_-]+)?$/.test(boundedString(override.contentType, 150, 'override.contentType'))) fail('override.contentType 必须是有效 MIME 类型。');
    }
  }
}

function decode(data         , limit        )         {
  if (typeof data !== 'string' || data.length > Math.ceil(limit / 3) * 4) fail('产物 Base64 数据无效或超过大小限制。');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) fail('产物必须使用规范 Base64 编码。');
  return bytes;
}

function validateEntries(files                            ) {
  if (!Array.isArray(files) || !files.length || files.length > VERCEL_OUTPUT_LIMITS.files) fail('完整部署产物必须包含 1–10000 个文件。');
  let size = 0;
  const names = new Set        ();
  const configs = new Map                    ();
  const functions = new Map                                        ();
  for (const file of files) {
    object(file, '产物清单项');
    const location = locateFile(file.file);
    if (names.has(file.file)) fail('完整部署产物包含重复路径。');
    names.add(file.file);
    if (!/^[a-f0-9]{40}$/.test(file.sha) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > VERCEL_OUTPUT_LIMITS.fileBytes) fail('产物 SHA-1 或文件大小无效。');
    size += file.size;
    if (size > VERCEL_OUTPUT_LIMITS.totalBytes) fail('完整部署产物总大小不得超过 64 MiB。');
    if (location.config && file.data === undefined) fail('发布清单必须包含 config.json 和每个 .vc-config.json 的 Base64 data，便于再次验证配置。');
    if (file.data !== undefined) {
      const bytes = decode(file.data, location.config ? VERCEL_OUTPUT_LIMITS.configBytes : VERCEL_OUTPUT_LIMITS.fileBytes);
      if (bytes.length !== file.size || createHash('sha1').update(bytes).digest('hex') !== file.sha) fail('产物清单中的 data 与 SHA-1/size 不一致。');
      validateVercelOutputFile(file.file, bytes);
      if (location.config) configs.set(file.file, parseConfig(bytes, file.file));
    }
    if (location.kind === 'function') functions.set(location.functionRoot , { root: location.functionRoot , name: location.functionName  });
  }
  // A path cannot simultaneously be a file and a directory, regardless of input order.
  for (const name of names) {
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count++) if (names.has(parts.slice(0, count).join('/'))) fail('完整部署产物包含文件与目录路径冲突。');
  }
  const config = configs.get(CONFIG);
  if (!config) fail('完整部署产物缺少 .vercel/output/config.json。');
  const functionUrls = new Set        ();
  for (const { root, name } of functions.values()) {
    const fnConfig = configs.get(`${root}.vc-config.json`);
    if (!fnConfig) fail(`函数 ${name} 缺少 .vc-config.json。`);
    const handler = validateFunctionConfig(fnConfig);
    if (!names.has(root + handler)) fail(`函数 ${name} 的 handler 不在该 .func 目录内；请包含完整运行依赖并重新构建。`);
    functionUrls.add(`/${name}`);
  }
  const staticUrls = new Set([...names].filter(name => name.startsWith(STATIC)).map(name => '/' + name.slice(STATIC.length)));
  if (config.overrides) {
    for (const [file, value] of Object.entries(config.overrides              )) {
      if (!names.has(STATIC + file)) fail('override 只能引用上传的 static 文件，不能引用函数或不存在的产物。');
      const override = value              ;
      if (override.path !== undefined) {
        const target = '/' + override.path;
        if (functionUrls.has(target) || (staticUrls.has(target) && target !== '/' + file)) fail('override.path 与函数或其他静态资源冲突。');
        staticUrls.delete('/' + file);
        staticUrls.add(target);
      }
    }
  }
  const destinations = new Set([...staticUrls, ...functionUrls]);
  if (staticUrls.has('/index.html')) destinations.add('/');
  let playableRoot = staticUrls.has('/index.html') || functionUrls.has('/index');
  const rootPatterns = new Set(['/', '^/$', '/?', '/?$', '^/?$', '/(.*)', '/(.*)$', '^/(.*)$', '/.*', '/.*$', '^/.*$', '/(.*)?', '^/(.*)?$']);
  for (const input of (config.routes || [])             ) {
    const route = validateRoute(input);
    if ('handle' in route) continue;
    const dest = route.dest?.split('?')[0];
    if (dest && !destinations.has(dest)) fail(`route.dest ${dest} 没有对应的静态文件或函数；请使用固定的已上传目标。`);
    if (dest && rootPatterns.has(route.src) && (!route.methods || route.methods.includes('GET')) && (!route.status || route.status === 200) && !route.continue && !route.headers?.location) playableRoot = true;
  }
  if (!playableRoot) fail('游戏需要可打开的根页面：提供 static/index.html、index.func，或把 / 映射到已上传函数/静态页面的根路由。');
  return { size, names };
}

/** Metadata must come from authenticated per-file upload receipts, not arbitrary client hashes. */
export function validateVercelOutputManifest(files                            ) {
  return validateEntries(files);
}

export function validateVercelOutputFiles(files                    ) {
  if (!Array.isArray(files) || !files.length || files.length > VERCEL_OUTPUT_LIMITS.files) fail('完整部署产物必须包含 1–10000 个文件。');
  return validateEntries(files.map(file => {
    object(file, '产物文件项');
    if (file.encoding !== 'base64') fail('产物必须使用 Base64 编码。');
    const bytes = decode(file.data, VERCEL_OUTPUT_LIMITS.fileBytes);
    // validateEntries rescans all data, including function modules, before returning success.
    return { file: file.file, data: file.data, sha: createHash('sha1').update(bytes).digest('hex'), size: bytes.length };
  }));
}
