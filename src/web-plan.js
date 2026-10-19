import { lstat,readFile,readdir } from 'node:fs/promises';
import { resolve,relative,isAbsolute,join,sep } from 'node:path';

export async function webPackage(root) {
  try {
    const path=join(root,'package.json'),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100000)throw new Error('UNSUPPORTED_BUILD: package.json 必须是普通文件且不超过 100 KB。');
    return JSON.parse(await readFile(path,'utf8'));
  } catch(error) {
    if(error.code==='ENOENT')return null;
    throw new Error('UNSUPPORTED_BUILD: 无法读取有效的 package.json。');
  }
}
// Script names a command line may run through npm, pnpm or yarn. Every word after `run` (or, for
// pnpm/yarn, after the tool) that is not a flag is treated as a possible name; names that are not
// scripts are simply skipped, so guessing too many is safe. npm's test/start/stop/restart run hooks too.
function nestedScripts(command) {
  const names=[];
  for(const segment of command.split(/&&|\|\||[;&|\n()]/)) {
    const words=segment.trim().split(/\s+/).filter(Boolean);
    const at=words.findIndex(word=>/^(?:\S*[\\/])?(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?$/i.test(word));
    if(at<0)continue;
    const tool=words[at].toLowerCase().replace(/^.*[\\/]/,'').replace(/\.(?:cmd|exe)$/,''),rest=words.slice(at+1);
    const end=rest.indexOf('--'),args=end<0?rest:rest.slice(0,end);
    const run=args.findIndex(word=>['run','run-script','rum','urn'].includes(word));
    const candidates=(run>=0?args.slice(run+1):tool==='npm'?args.filter(word=>['test','t','tst','start','stop','restart'].includes(word)).map(word=>word.startsWith('t')?'test':word):args).filter(word=>!word.startsWith('-'));
    names.push(...candidates.filter(word=>/^[A-Za-z0-9:_-]+$/.test(word)));
  }
  return names;
}
export function validateBuildScript(pkg,script) {
  if(script===undefined)return;
  if(!/^[A-Za-z0-9:_-]{1,80}$/.test(script)||typeof pkg?.scripts?.[script]!=='string'||!pkg.scripts[script].trim())throw new Error('UNSUPPORTED_BUILD: build_script 必须是 package.json 中已有的 npm 脚本名称。');
  const seen=new Set();
  function inspect(name) {
    if(seen.has(name))return;seen.add(name);
    const command=pkg.scripts[name];if(typeof command!=='string')return;
    if(/(?:^|[\s;&|])(?:\S*[\\/])?(?:vercel|vc)(?:@[^\s;&|]+)?(?:\s|$)/i.test(command))throw new Error('UNSUPPORTED_BUILD: 构建脚本不能调用 Vercel CLI。请使用无需 Vercel 登录或云项目的本地框架适配器生成 Build Output API v3 产物，由 1GP 统一部署。');
    // Nested scripts run their own pre/post hooks too. Read each command of the line word by word,
    // so flags anywhere (npm --silent run x, npm run --if-present x, pnpm -s x) cannot hide a name.
    for(const name of nestedScripts(command))for(const hook of [`pre${name}`,name,`post${name}`])inspect(hook);
  }
  for(const name of [`pre${script}`,script,`post${script}`])inspect(name);
}
// Accept only a literal exported config: comments, strings mentioning output,
// spreads, getters and dynamic expressions cannot prove a static-only build.
function literalStaticNext(source) {
  const tokens=[];let index=0;
  while(index<source.length) {
    if(/\s/.test(source[index])){index++;continue;}
    if(source.startsWith('//',index)){const end=source.indexOf('\n',index+2);index=end<0?source.length:end+1;continue;}
    if(source.startsWith('/*',index)){const end=source.indexOf('*/',index+2);if(end<0)return false;index=end+2;continue;}
    const char=source[index];
    if(char==='"'||char==="'") {
      let value='';const quote=char;index++;
      while(index<source.length&&source[index]!==quote){if(source[index]==='\\')return false;value+=source[index++];}
      if(source[index++]!==quote)return false;tokens.push({value,string:true});continue;
    }
    const identifier=source.slice(index).match(/^[A-Za-z_$][\w$]*/);
    if(identifier){tokens.push({value:identifier[0]});index+=identifier[0].length;continue;}
    const number=source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?/);
    if(number){tokens.push({value:number[0],number:true});index+=number[0].length;continue;}
    if('{}[],:;=.'.includes(char)){tokens.push({value:char});index++;continue;}
    return false;
  }
  let cursor=0;
  const take=value=>{if(tokens[cursor]?.value!==value)throw new Error('not literal');cursor++;};
  function value() {
    const token=tokens[cursor++];if(!token)throw new Error('missing literal');
    if(token.string)return token.value;
    if(token.number)return Number(token.value);
    if(['true','false','null'].includes(token.value))return JSON.parse(token.value);
    if(token.value==='['){const array=[];while(tokens[cursor]?.value!==']'){array.push(value());if(tokens[cursor]?.value!==']')take(',');}take(']');return array;}
    if(token.value==='{') {
      const object=Object.create(null);
      while(tokens[cursor]?.value!=='}') {
        const key=tokens[cursor++];if(!key||!key.string&&!/^[A-Za-z_$][\w$]*$/.test(key.value)||Object.hasOwn(object,key.value))throw new Error('not literal key');
        take(':');object[key.value]=value();if(tokens[cursor]?.value!=='}')take(',');
      }
      take('}');return object;
    }
    throw new Error('not literal value');
  }
  try {
    let config;
    if(tokens[cursor]?.value==='export'){take('export');take('default');config=value();}
    else if(tokens[cursor]?.value==='module'){take('module');take('.');take('exports');take('=');config=value();}
    else {
      take('const');const name=tokens[cursor++];if(!name||name.string)throw new Error('not config name');take('=');config=value();
      if(tokens[cursor]?.value===';')cursor++;take('export');take('default');take(name.value);
    }
    if(tokens[cursor]?.value===';')cursor++;
    return cursor===tokens.length&&config?.output==='export';
  }catch{return false;}
}
// Inspect source/configuration as data only. A backend must never be silently
// dropped merely because a frontend index.html also exists.
export async function serverRequirements(root,pkg) {
  const reasons=[];
  for(const path of ['api','server','backend','src/server','src/api','pages/api','src/pages/api']) {
    const stat=await lstat(join(root,path)).catch(()=>null);
    if(stat)reasons.push(path);
  }
  for(const name of await readdir(root))if(/^(?:server|middleware|proxy)\.[cm]?[jt]sx?$/.test(name))reasons.push(name);
  const dependencies={...pkg?.dependencies,...pkg?.devDependencies};
  for(const name of ['express','fastify','@fastify/core','koa','hono','socket.io','ws','@nestjs/core'])if(dependencies[name])reasons.push(name);
  // Next.js can explicitly export a static site; don't turn that valid mode
  // into a server requirement based on the framework name alone.
  let staticNext=false,nextConfigs=0;
  for(const name of ['next.config.js','next.config.mjs','next.config.ts','next.config.cjs']) {
    const stat=await lstat(join(root,name)).catch(()=>null);
    if(stat){nextConfigs++;if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=100000)staticNext=literalStaticNext(await readFile(join(root,name),'utf8'));}
  }
  staticNext=nextConfigs===1&&staticNext;
  if((dependencies.next||Object.values(pkg?.scripts||{}).some(value=>typeof value==='string'&&/\bnext\s+(?:build|start)\b/.test(value)))&&!staticNext)reasons.push('Next.js server/SSR');
  if(dependencies.nuxt||dependencies['@nuxt/kit']||dependencies['@sveltejs/adapter-vercel']||dependencies['@astrojs/vercel'])reasons.push('server framework adapter');
  for(const start of ['app','src/app','src/routes']) {
    let visited=0;
    async function walk(path,depth=0) {
      if(depth>12)return;
      for(const entry of await readdir(path,{withFileTypes:true}).catch(()=>[])) {
        if(++visited>3000)throw new Error('UNSUPPORTED_BUILD: 服务端检测超过 3000 个文件，请缩小项目目录。');
        if(entry.isSymbolicLink())continue;
        if(entry.isDirectory())await walk(join(path,entry.name),depth+1);
        else if(/^(?:route\.[cm]?[jt]s|\+server\.[cm]?[jt]s|\+(?:page|layout)\.server\.[cm]?[jt]s)$/.test(entry.name))reasons.push(relative(root,join(path,entry.name)).split(sep).join('/'));
      }
    }
    await walk(join(root,start));
  }
  return [...new Set(reasons)];
}
export const fullGameGuidance='存在 API、服务端或 SSR 时不能只发布前端。普通 Vite/npm 静态前端 + api/*.js/ts 可先调用 build_vercel_game，在本地直接生成完整产物，无需 Vercel 登录。其他框架请用其本地适配器/构建脚本生成 Vercel Build Output API v3（.vercel/output/config.json、static/、functions/，含各 .func/.vc-config.json 和运行依赖），再使用 deployment_target="vercel"、vercel_output_directory=".vercel/output"；如需构建，提供已有 npm build_script。只需 1GP 授权，不要登录 Vercel、创建个人云项目或直接部署。需要常驻进程/WebSocket 或服务器内存房间的游戏应使用 1GP Docker 托管。';
// A caller can select an artifact folder, never escape through .. or symlinks.
export async function outputPath(root,directory,{building=false}={}) {
  if(typeof directory!=='string'||!directory||isAbsolute(directory)||/[\\:\0]/.test(directory)||directory.split('/').includes('..'))throw new Error('UNSUPPORTED_BUILD: output_directory 必须是项目内的相对目录。');
  const output=resolve(root,directory),rel=relative(root,output);
  if(building&&!rel)throw new Error('UNSUPPORTED_BUILD: 构建输出目录不能是项目根目录。');
  const parts=rel?rel.split(sep):[];
  if(parts.some(p=>['.git','.next','.nuxt','.svelte-kit','node_modules','src','api','server'].includes(p)))throw new Error('UNSUPPORTED_BUILD: 请选择独立的网页产物目录，不要选择源码或依赖目录。');
  let current=root;
  for(const part of parts) {
    current=join(current,part);
    try {const stat=await lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('UNSUPPORTED_BUILD: 输出目录不能经过符号链接或普通文件。');}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
  }
  return output;
}
export async function planWeb(root,{outputDirectory,buildScript}={}) {
  const pkg=await webPackage(root);
  validateBuildScript(pkg,buildScript);
  const server=await serverRequirements(root,pkg);
  if(server.length)throw new Error(`VERCEL_OUTPUT_REQUIRED: ${fullGameGuidance} 检测依据：${server.join('、')}`);
  if(outputDirectory?.split('/').includes('.vercel'))throw new Error(`VERCEL_OUTPUT_REQUIRED: ${fullGameGuidance}`);
  if(outputDirectory!==undefined) {
    const output=await outputPath(root,outputDirectory,{building:!!buildScript});
    if(output===root&&pkg&&Object.keys(pkg.scripts||{}).some(k=>/build|export/.test(k)))throw new Error('UNSUPPORTED_BUILD: 有构建脚本的项目请指定独立产物目录，不能上传项目根目录。');
    return {kind:buildScript?'custom':'prebuilt',pkg,output,outputDirectory,buildScript};
  }
  if(buildScript)throw new Error('UNSUPPORTED_BUILD: 运行自定义构建脚本时必须提供 output_directory。');
  if((pkg?.dependencies?.vite||pkg?.devDependencies?.vite)&&typeof pkg.scripts?.build==='string'&&pkg.scripts.build.trim()){validateBuildScript(pkg,'build');return {kind:'vite',pkg,buildScript:'build'};}
  if(!pkg) {
    try{const stat=await lstat(join(root,'index.html'));if(stat.isFile()&&!stat.isSymbolicLink())return {kind:'prebuilt',pkg,output:root,outputDirectory:'.'};}catch{}
  }
  return {kind:'choose-output',pkg};
}
