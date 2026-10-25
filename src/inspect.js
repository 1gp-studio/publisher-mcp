import { readFile,lstat,realpath } from 'node:fs/promises';
import { resolve,isAbsolute,join,basename } from 'node:path';
import { createHash } from 'node:crypto';
import { planWeb,fullGameGuidance } from './web-plan.js';
import { planVercel,bundleVercelOutput,artifactErrorCode } from './vercel-output.js';
import { bundleOutput } from './bundle.js';
import { updateFreshnessWarnings } from './update-freshness.js';
// Service worker / long-cache reminders for the files about to be uploaded (update-freshness.js).
const freshness=files=>{const warnings=updateFreshnessWarnings(files);return warnings.length?{warnings}:{};};
import { bundleGodotExport } from './godot.js';
const unsupported=reason=>({supported:false,code:artifactErrorCode({message:reason}),reason});
// A metadata file read as text: a regular file, not a symlink, of sane size.
export async function file(directory,name) {
  const path=join(directory,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(name==='package.json'?100000:10000000))throw new Error('Invalid metadata file');
  return readFile(path,'utf8');
}
export const DEFAULT_DESCRIPTION='独立网页游戏。';
// Template and folder names are not game titles; the page's own <title> usually is.
const placeholderTitle=/^(?:vite(?:[-_ ](?:app|project))?|vite \+ .*|react(?:[-_ ]app)?|my[-_ ]?(?:app|game|project)|app|game|web|site|project|new[-_ ]project|untitled.*|document|index|html)$/i;
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
async function pageTitle(directory) {
  try {
    const match=(await file(directory,'index.html')).match(/<title[^>]*>([^<]*)<\/title>/i);
    return (match?.[1]??'').replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi,(entity,dec,hex,name)=>dec||hex?String.fromCodePoint(parseInt(dec??hex,dec?10:16)):entities[name.toLowerCase()]??entity).replace(/\s+/g,' ').trim();
  } catch { return ''; }
}
async function gameTitle(directory,pkg) {
  const names=[await pageTitle(directory),typeof pkg?.name==='string'?pkg.name.replace(/^@[^/]+\//,''):'',basename(directory)].map(name=>name.trim().slice(0,120)).filter(Boolean);
  return names.find(name=>!placeholderTitle.test(name))??names[0]??'Untitled game';
}
// project.godot [application] config/name and config/description, as plain data.
export function godotMetadata(text) {
  const value=key=>{const match=text.match(new RegExp(`^config/${key}="((?:[^"\\\\]|\\\\.)*)"`,'m'));return match?match[1].replace(/\\"/g,'"').trim():'';};
  const title=value('name').slice(0,120),description=value('description').slice(0,2000);
  return {...(title?{title}:{}),...(description?{description}:{})};
}
async function inspectGodot(directory,meta) {
  let bundle;
  try{bundle=await bundleGodotExport(directory);}
  catch(error){return {...unsupported(error.message.replace(/^UNSUPPORTED_BUILD: /,'')),engine:'godot',alternative:'publish_link',...meta};}
  const base={engine:'godot',buildMethod:'godot-web',source:'local',projectId:bundle.projectId,title:meta.title||'Untitled game',description:meta.description||DEFAULT_DESCRIPTION,build:{export:bundle.exportDirectory,engineFile:bundle.runtime.file,engineSha1:bundle.runtime.sha,engineBytes:bundle.runtime.size},fileCount:bundle.files.length,sourceBytes:bundle.size};
  if(bundle.stale)return {supported:true,ready:false,...base,reason:'网页导出早于当前源码。请先重新导出 Web 版本（MCP 不会运行 Godot），再发布。'};
  return {supported:true,ready:true,...base,...freshness(bundle.files),reason:'支持 Godot 网页导出：只上传导出目录里的小文件（不含引擎 wasm），平台附加托管的同版本引擎并直接部署，不需要构建或 GitHub。'};
}
export async function inspectGame(projectDirectory,options={}) {
  if(!isAbsolute(projectDirectory))return unsupported('请提供当前游戏项目的绝对路径。');
  let directory;
  try{directory=await realpath(resolve(projectDirectory));}catch{return unsupported('无法读取项目目录。');}
  let godot=null;
  try{godot=await file(directory,'project.godot');}catch{}
  if(godot!==null&&!options.outputDirectory&&!options.buildScript&&!options.vercelOutputDirectory&&options.deploymentTarget!=='vercel')return inspectGodot(directory,godotMetadata(godot));
  let plan;
  try{plan=await planVercel(directory,options);}catch(error){return unsupported(error.message);}
  if(plan) {
    const base={supported:true,source:'local',buildMethod:'vercel-output',projectId:createHash('sha256').update(directory).digest('hex').slice(0,32),title:await gameTitle(directory,plan.pkg),description:typeof plan.pkg?.description==='string'&&plan.pkg.description.trim()?plan.pkg.description.trim().slice(0,2000):DEFAULT_DESCRIPTION,build:{mode:plan.kind,output:plan.outputDirectory,...(plan.buildScript?{script:plan.buildScript,location:'local'}:{}),hosting:'AIWANNA managed Vercel'}};
    if(plan.missing)return {...base,ready:false,code:'VERCEL_OUTPUT_REQUIRED',reason:fullGameGuidance,scripts:Object.keys(plan.pkg?.scripts||{})};
    if(plan.buildScript)return {...base,ready:true,reason:'发布时在本地运行已有 npm 构建脚本，将完整 Vercel v3 产物（网页、路由、Node.js 22/24 函数及必要运行依赖）上传给 AIWANNA 统一部署。无需用户登录 Vercel 或创建云项目；检查本身不执行脚本。'};
    try {
      const bundle=await bundleVercelOutput(directory,plan.output);
      return {...base,ready:true,...freshness(bundle.files),fileCount:bundle.files.length,functionCount:bundle.functionCount,artifactBytes:bundle.size,uploadFiles:bundle.files.map(file=>file.file),excludedFiles:bundle.excluded,reason:'上传完整 Vercel v3 产物，由 AIWANNA 统一托管网页和服务端；无需用户 Vercel 登录、凭证或云项目。浏览器资源对玩家公开，函数产物仅用于平台服务端运行。'};
    }catch(error){return unsupported(error.message);}
  }
  try{plan=await planWeb(directory,options);}catch(error){return unsupported(error.message);}
  const pkg=plan.pkg;
  const base={supported:true,buildMethod:'web-static',source:'local',projectId:createHash('sha256').update(directory).digest('hex').slice(0,32),title:await gameTitle(directory,pkg),description:typeof pkg?.description==='string'&&pkg.description.trim()?pkg.description.trim().slice(0,2000):DEFAULT_DESCRIPTION};
  if(plan.kind==='choose-output')return {...base,ready:false,code:'OUTPUT_REQUIRED',reason:'无需转换成 Vite。纯静态游戏已有产物时指定 output_directory（如 dist、build、out），需要构建时同时提供已有 build_script。有服务端的游戏应生成完整 Vercel Build Output API v3，再指定 deployment_target="vercel"，由 AIWANNA 统一托管前后端。',scripts:Object.keys(pkg?.scripts||{})};
  if(plan.kind==='prebuilt') {
    try{const bundle=await bundleOutput(directory,plan.output);return {...base,ready:true,...freshness(bundle.files),build:{mode:'prebuilt',output:plan.outputDirectory},fileCount:bundle.files.length,artifactBytes:bundle.size,uploadFiles:bundle.files.map(f=>f.file),excludedFiles:bundle.excluded,reason:'直接上传所选静态网页目录，不运行构建。HTML、浏览器 JavaScript 和资源会提供给平台及玩家；纯 HTML/JS 项目的这些文件本身就是可发布代码。请确认文件清单不含私密内容。'};}catch(error){return unsupported(error.message);}
  }
  return {...base,ready:true,build:{mode:plan.kind,script:plan.buildScript,output:plan.outputDirectory||'<temporary-directory>',location:'local',upload:'web output only'},reason:'发布时在本地运行项目构建脚本，只上传网页产物（最多 3 MB、300 个文件），不上传项目源码树、依赖或 source map。请先安装项目依赖。网页 JavaScript 和资源仍可被平台及玩家读取。检查本身不会执行脚本。'};
}
