import { build } from 'esbuild';
import { lstat,readdir,readFile,writeFile,mkdir,mkdtemp,rename,rm,realpath,open } from 'node:fs/promises';
import { join,dirname,isAbsolute } from 'node:path';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { webPackage,outputPath,validateBuildScript } from './web-plan.js';
import { runBuild } from './bundle.js';
import { bundleVercelOutput } from './vercel-output.js';
import { validateVercelOutputFile,VERCEL_OUTPUT_LIMITS } from './vercel-validation.js';
import { managedVercelDirectory,vercelSourceFingerprint } from './vercel-freshness.js';

const managedDirectory=managedVercelDirectory;
const fail=message=>{throw new Error('UNSUPPORTED_BUILD: '+message);};
const object=(value,label)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} 必须是对象。`);return value;};
const onlyKeys=(value,keys,label)=>{for(const key of Object.keys(value))if(!keys.includes(key))fail(`${label} 的 ${key} 尚不能由本地适配器转换；请使用完整预构建产物或 AIWANNA Docker，不会忽略此配置。`);};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function configuration(root) {
  const path=join(root,'vercel.json'),stat=await lstat(path).catch(()=>null);
  if(!stat)return {};
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100*1024)fail('vercel.json 必须是至多 100 KiB 的普通文件。');
  let config;try{config=object(JSON.parse(await readFile(path,'utf8')),'vercel.json');}catch(error){if(error.message.startsWith('UNSUPPORTED_BUILD:'))throw error;fail('vercel.json 必须是有效 JSON。');}
  onlyKeys(config,['$schema','version','framework','buildCommand','outputDirectory','rewrites','functions'],'vercel.json');
  if(config.version!==undefined&&config.version!==2)fail('vercel.json 只支持 version: 2。');
  if(config.framework!==undefined&&config.framework!==null&&config.framework!=='vite')fail('本地适配器仅自动构建 Vite 前端；其他框架请提供完整预构建产物。');
  if(config.buildCommand!==undefined&&(typeof config.buildCommand!=='string'||!/^npm run [A-Za-z0-9:_-]{1,80}$/.test(config.buildCommand)))fail('vercel.json buildCommand 仅支持 npm run <已有脚本>；请明确使用本地前端脚本，不运行云端命令。');
  if(config.outputDirectory!==undefined&&(typeof config.outputDirectory!=='string'||!config.outputDirectory))fail('vercel.json outputDirectory 必须是相对目录。');
  return config;
}

export function convertRewrites(input=[]) {
  if(!Array.isArray(input)||input.length>500)fail('rewrites 必须是最多 500 条规则的数组。');
  return input.map(value=>{
    const rule=object(value,'rewrite');onlyKeys(rule,['source','destination'],'rewrite');
    if(typeof rule.source!=='string'||typeof rule.destination!=='string'||!rule.source.startsWith('/')||!rule.destination.startsWith('/'))fail('rewrite 需要同源 source 和 destination。');
    let src,dest=rule.destination;
    if(rule.source==='/(.*)')src='^/(.*)$';
    else {
      const match=rule.source.match(/^(.*)\/:([A-Za-z][A-Za-z0-9_]*)\*$/);
      if(match) {
        if(!/^\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]*$/.test(match[1]||'/'))fail('仅支持固定路径和末尾 :name* 的 rewrite。');
        src='^'+escape(match[1])+'(?:/(.*))?$';dest=dest.replaceAll(':'+match[2]+'*','$1');
      }else {
        if(!/^\/[A-Za-z0-9_./~-]*$/.test(rule.source))fail('仅支持固定路径和末尾 :name* 的 rewrite；动态参数请生成完整预构建路由。');
        src='^'+escape(rule.source)+'$';
      }
    }
    if(dest.includes(':')||dest.split('?')[0].includes('$'))fail('rewrite 目标必须是固定同源函数或静态文件；捕获参数只能放在查询参数中。');
    return {src,dest};
  });
}

async function apiEntries(root) {
  const api=join(root,'api'),stat=await lstat(api).catch(()=>null),entries=[];
  if(!stat)return entries;
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('api 必须是项目内普通目录。');
  let visited=0;
  async function walk(path,prefix='') {
    for(const entry of await readdir(path,{withFileTypes:true})) {
      if(++visited>3000)fail('api 源目录过大，请生成专用完整产物。');
      const name=prefix+entry.name,absolute=join(path,entry.name),info=await lstat(absolute);
      if(info.isSymbolicLink())fail('本地 API 入口不能是符号链接。');
      if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
      if(info.isDirectory()){await walk(absolute,name+'/');continue;}
      if(!/\.[cm]?[jt]s$/.test(name)||/\.d\.ts$/.test(name))continue;
      if(!/^[A-Za-z0-9_./-]+\.[cm]?[jt]s$/.test(name))fail('API 动态路径（如 [id].ts）暂不支持；请生成显式路由的完整产物。');
      entries.push({file:'api/'+name,path:absolute,name:'api/'+name.replace(/\.[cm]?[jt]s$/,'')});
    }
  }
  await walk(api);
  const names=new Set();for(const entry of entries){if(names.has(entry.name))fail('API 文件映射到重复路径，请只保留一个入口。');names.add(entry.name);}
  return entries;
}

function functionSettings(config,entries) {
  const settings=new Map(entries.map(entry=>[entry.file,{}]));
  if(config===undefined)return settings;
  object(config,'functions');
  for(const [pattern,value] of Object.entries(config)) {
    const rule=object(value,'functions 设置');onlyKeys(rule,['maxDuration','memory'],'functions 设置');
    if(!/^api\/[A-Za-z0-9_./*-]+\.[cm]?[jt]s$/.test(pattern))fail('functions 仅支持匹配 api/*.js/ts 的固定路径或 *、** 通配符。');
    let glob='';for(let i=0;i<pattern.length;i++){if(pattern.slice(i,i+3)==='**/'){glob+='(?:.*/)?';i+=2;}else if(pattern.slice(i,i+2)==='**'){glob+='.*';i++;}else if(pattern[i]==='*')glob+='[^/]*';else glob+=escape(pattern[i]);}
    const regex='^'+glob+'$';
    const matches=entries.filter(entry=>new RegExp(regex).test(entry.file));
    if(!matches.length)fail(`functions 规则 ${pattern} 没有匹配 API 入口，不能忽略。`);
    for(const entry of matches)settings.set(entry.file,{...settings.get(entry.file),...rule});
  }
  return settings;
}

async function copyFrontend(source,destination) {
  const stat=await lstat(source).catch(()=>null);if(!stat?.isDirectory()||stat.isSymbolicLink())fail('未生成前端输出目录，请检查已有 build_script 与 frontend_output_directory。');
  let total=0,count=0;
  async function walk(directory,prefix='') {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const name=prefix+entry.name,path=join(directory,entry.name),info=await lstat(path);
      if(info.isSymbolicLink())fail('前端输出包含符号链接，请生成独立的浏览器资源。');
      if(/\.map$/i.test(name))continue;
      if(['api','server'].includes(entry.name))fail('前端输出混入服务端目录，请为前端设置专用输出目录。');
      if(info.isDirectory()){await walk(path,name+'/');continue;}
      if(!info.isFile())fail('前端产物只能包含普通文件。');
      total+=info.size;if(++count>VERCEL_OUTPUT_LIMITS.files||total>VERCEL_OUTPUT_LIMITS.totalBytes||info.size>VERCEL_OUTPUT_LIMITS.fileBytes)fail('前端产物超过完整 Vercel 发布大小限制。');
      const bytes=await readFile(path);validateVercelOutputFile('.vercel/output/static/'+name,bytes);
      await mkdir(dirname(join(destination,name)),{recursive:true});await writeFile(join(destination,name),bytes);
    }
  }
  await mkdir(destination,{recursive:true});await walk(source);
}

async function bundleFunction(root,entry,directory,settings) {
  await mkdir(directory,{recursive:true});
  let result;
  try {
    result=await build({absWorkingDir:root,entryPoints:[entry.path],outfile:join(directory,'module.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',packages:'bundle',sourcemap:false,metafile:true,logLevel:'silent',legalComments:'none',logOverride:{'unsupported-require-call':'error','unsupported-dynamic-import':'error','empty-import-meta':'error'},plugins:[{
      name:'ws-optional-native-fallback',setup(buildApi){
        // ws documents a pure-JavaScript fallback for these two optional native
        // accelerators. Materialize their absence only for ws's own guarded
        // imports so a local macOS addon can never enter a Linux deployment.
        buildApi.onResolve({filter:/^(?:bufferutil|utf-8-validate)$/},args=>{
          const importer=args.importer.replaceAll('\\','/');
          if(args.path==='bufferutil'&&importer.endsWith('/node_modules/ws/lib/buffer-util.js')||args.path==='utf-8-validate'&&importer.endsWith('/node_modules/ws/lib/validation.js'))return {path:args.path,namespace:'ws-optional'};
        });
        buildApi.onLoad({filter:/.*/,namespace:'ws-optional'},()=>({contents:`module.exports = (() => { const error = new Error('Optional ws native accelerator is not included'); error.code = 'MODULE_NOT_FOUND'; throw error; })();`,loader:'js'}));
      }
    }]});
  }catch {throw new Error(`LOCAL_BUILD_FAILED: 无法将 ${entry.file} 打包为自包含 Node.js 函数。请确认已安装依赖；动态 require、原生模块或未打包的运行资源需要项目专用适配器/AIWANNA Docker。没有发布游戏。`);}
  const builtins=new Set(builtinModules.flatMap(name=>[name,'node:'+name]));
  for(const output of Object.values(result.metafile.outputs))for(const item of output.imports)if(item.external&&!builtins.has(item.path))fail(`函数 ${entry.file} 仍依赖未打包模块；请生成自包含产物。`);
  // esbuild records the entire resolved dependency graph, including packages and re-exports.
  // It does not trace runtime files. Refuse filesystem access anywhere in that graph instead of
  // guessing which read methods/paths are used together in an individual source file. Runtime
  // module/process loaders can introduce files outside the graph, so they need a dedicated adapter
  // too. Static JSON imports and ws's explicitly materialized optional fallbacks remain supported.
  const untracedRuntime=new Set(['fs','fs/promises','module','child_process','worker_threads','vm']);
  for(const [input,metadata] of Object.entries(result.metafile.inputs)) {
    const unsupported=metadata.imports.find(item=>item.external&&untracedRuntime.has(item.path.replace(/^node:/,'')));
    if(unsupported)fail(`函数 ${entry.file} 的依赖 ${input.split('\\').join('/')} 使用 ${unsupported.path}，可能在运行时读取文件或加载未打包代码，无法确认产物完整。请把数据改成 import 引入（例如 import levels from './levels.json'），或使用项目专用适配器 / AIWANNA Docker。`);
  }
  // Do not execute the game during compilation or substitute process.env.
  // This wrapper preserves both Node req/res handlers and exported http.Server.
  await writeFile(join(directory,'index.cjs'),`const exported = require('./module.cjs');\nconst handler = exported.default ?? exported;\nmodule.exports = function(req, res) {\n  if (typeof handler === 'function') return handler(req, res);\n  if (handler && typeof handler.emit === 'function' && typeof handler.listeners === 'function' && handler.listeners('request').length) return handler.emit('request', req, res);\n  throw new TypeError('API must export a Node request handler or an http.Server with a request listener');\n};\n`);
  await writeFile(join(directory,'.vc-config.json'),JSON.stringify({runtime:'nodejs22.x',handler:'index.cjs',launcherType:'Nodejs',shouldAddHelpers:true,...settings}));
}

export async function buildVercelGame(projectDirectory,{frontendOutputDirectory,buildScript}={}) {
  if(!isAbsolute(projectDirectory))fail('请提供游戏项目的绝对路径。');
  const root=await realpath(projectDirectory),pkg=await webPackage(root),config=await configuration(root),entries=await apiEntries(root);
  const vite=!!(pkg?.dependencies?.vite||pkg?.devDependencies?.vite);
  const script=buildScript??(frontendOutputDirectory?undefined:config.buildCommand?.slice('npm run '.length)??(vite?'build':undefined));
  const frontendDirectory=frontendOutputDirectory??config.outputDirectory;
  if(!vite&&!frontendDirectory)fail('此适配器自动支持 Vite；其他 npm 静态前端请明确 frontend_output_directory，并按需提供已有 build_script。Next/SSR 请使用其完整框架适配器。');
  if(script)validateBuildScript(pkg,script);
  if(config.buildCommand&&buildScript&&config.buildCommand!=='npm run '+buildScript)fail('build_script 与 vercel.json buildCommand 不一致，请明确项目实际构建配置。');
  if(config.outputDirectory&&frontendOutputDirectory&&config.outputDirectory!==frontendOutputDirectory)fail('frontend_output_directory 与 vercel.json outputDirectory 不一致，请使用相同的前端产物目录。');
  if(script&&!vite&&!frontendDirectory)fail('自定义前端构建需要 frontend_output_directory。');
  const settings=functionSettings(config.functions,entries),routes=convertRewrites(config.rewrites);
  const managed=await outputPath(root,managedDirectory,{building:true}),parent=dirname(managed),marker=join(parent,'vercel-output.owner.json');
  const owner=createHash('sha256').update(root).digest('hex');
  await mkdir(parent,{recursive:true});
  const lockPath=join(parent,'vercel-output.lock');let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch{throw new Error('LOCAL_BUILD_FAILED: 此项目已有完整产物构建正在执行，或存在未处理的构建锁；请先检查，不会覆盖现有产物。');}
  let temp;
  try {
    const old=await lstat(managed).catch(()=>null),markerStat=await lstat(marker).catch(()=>null);
    let previousOwner;try{if(markerStat?.isFile()&&!markerStat.isSymbolicLink())previousOwner=JSON.parse(await readFile(marker,'utf8')).projectId;}catch{}
    if(old&&(!old.isDirectory()||old.isSymbolicLink()||previousOwner!==owner))fail('.1gp/vercel-output 已存在且不属于此工具管理，不会覆盖；请保留或移动它后重试。');
    if(markerStat&&previousOwner!==owner)fail('完整产物管理标记不匹配，不会覆盖现有文件。');
    const sourceInputs={...(frontendDirectory?{frontendDirectory}:{}),generatedFrontend:Boolean(script)};
    const sourceFingerprint=await vercelSourceFingerprint(root,sourceInputs);
    temp=await mkdtemp(join(root,'.1gp-vercel-build-'));const output=join(temp,'output'),staticDirectory=join(output,'static');await mkdir(output);
    if(frontendDirectory) {
      const source=await outputPath(root,frontendDirectory,{building:true});
      const before=script?await lstat(join(source,'index.html')).catch(()=>null):null;
      if(script)await runBuild(root,script);
      const after=await lstat(join(source,'index.html')).catch(()=>null);
      if(script&&(!after||before&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs))throw new Error('LOCAL_BUILD_FAILED: 前端构建未生成新的 index.html；若使用已有产物，请显式传 frontend_output_directory 并省略 build_script。');
      await copyFrontend(source,staticDirectory);
    }else {
      if(!script)fail('没有可运行的前端构建脚本。');
      const frontend=join(temp,'frontend');await mkdir(frontend);await runBuild(root,script,['--outDir',frontend,'--emptyOutDir']);await copyFrontend(frontend,staticDirectory);
    }
    for(const entry of entries)await bundleFunction(root,entry,join(output,'functions',entry.name+'.func'),settings.get(entry.file));
    await writeFile(join(output,'config.json'),JSON.stringify({version:3,routes:[...routes,{handle:'filesystem'},{src:'/(.*)',dest:'/index.html'}]}));
    const bundle=await bundleVercelOutput(root,output);
    if(sourceFingerprint!==await vercelSourceFingerprint(root,sourceInputs))throw new Error('LOCAL_BUILD_FAILED: 构建期间源码或构建配置发生变化，未替换已有托管产物。请等修改完成后重新调用 build_vercel_game。');
    if(old)await rename(managed,join(temp,'previous-output'));
    try{await rename(output,managed);await writeFile(marker,JSON.stringify({tool:'1gp-publisher-mcp',version:2,projectId:owner,sourceFingerprint,sourceInputs}),{mode:0o600});}
    catch(error){if(old){await rm(managed,{recursive:true,force:true});await rename(join(temp,'previous-output'),managed);}throw error;}
    return {ready:true,buildMethod:'vercel-output',project_directory:root,deployment_target:'vercel',vercel_output_directory:managedDirectory,functionCount:entries.length,fileCount:bundle.files.length,artifactBytes:bundle.size,uploadFiles:bundle.files.map(file=>file.file),message:'已在本地构建前端与 API 函数，未上传或部署。复用已有 prepare_game 的游戏识别、发布渠道、版本差异和 updateId；尚未准备时才调用 prepare_game，不重复 prepare_release。用本次返回的 project_directory、deployment_target、vercel_output_directory 调用 publish_game，带上原准备的 release.updateId，不再传 build_script 重复构建。由 AIWANNA 统一托管，无需 Vercel 登录。'};
  }finally{if(temp)await rm(temp,{recursive:true,force:true});await lock.close();await rm(lockPath,{force:true});}
}
