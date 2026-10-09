import { readFile,lstat,realpath } from 'node:fs/promises';
import { resolve,isAbsolute,join,basename } from 'node:path';
import { createHash } from 'node:crypto';
import { planWeb } from './web-plan.js';
import { bundleOutput } from './bundle.js';
import { bundleGodotExport } from './godot.js';
const unsupported=reason=>({supported:false,code:reason.startsWith('POTENTIAL_SECRET')?'POTENTIAL_SECRET':'UNSUPPORTED_BUILD',reason});
// A metadata file read as text: a regular file, not a symlink, of sane size.
export async function file(directory,name) {
  const path=join(directory,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(name==='package.json'?100000:10000000))throw new Error('Invalid metadata file');
  return readFile(path,'utf8');
}
export const DEFAULT_DESCRIPTION='独立网页游戏。';
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
  return {supported:true,ready:true,...base,reason:'支持 Godot 网页导出：只上传导出目录里的小文件（不含引擎 wasm），平台附加托管的同版本引擎并直接部署，不需要构建或 GitHub。'};
}
export async function inspectGame(projectDirectory,options={}) {
  if(!isAbsolute(projectDirectory))return unsupported('请提供当前游戏项目的绝对路径。');
  let directory;
  try{directory=await realpath(resolve(projectDirectory));}catch{return unsupported('无法读取项目目录。');}
  let godot=null;
  try{godot=await file(directory,'project.godot');}catch{}
  if(godot!==null&&!options.outputDirectory&&!options.buildScript)return inspectGodot(directory,godotMetadata(godot));
  let plan;
  try{plan=await planWeb(directory,options);}catch(error){return unsupported(error.message);}
  const pkg=plan.pkg;
  const base={supported:true,buildMethod:'web-static',source:'local',projectId:createHash('sha256').update(directory).digest('hex').slice(0,32),title:typeof pkg?.name==='string'?pkg.name.replace(/^@[^/]+\//,'').slice(0,120)||'Untitled game':basename(directory).slice(0,120)||'Untitled game',description:typeof pkg?.description==='string'&&pkg.description.trim()?pkg.description.trim().slice(0,2000):DEFAULT_DESCRIPTION};
  if(plan.kind==='choose-output')return {...base,ready:false,code:'OUTPUT_REQUIRED',reason:'无需转换成 Vite。请检查项目的静态导出方式：已有产物时指定 output_directory（如 dist、build、out）；需要构建时同时提供 package.json 中的 build_script 名称。不能上传需要服务端的输出；此类项目请先自行托管，再用 publish_link。',scripts:Object.keys(pkg?.scripts||{}),alternative:'publish_link'};
  if(plan.kind==='prebuilt') {
    try{const bundle=await bundleOutput(directory,plan.output);return {...base,ready:true,build:{mode:'prebuilt',output:plan.outputDirectory},fileCount:bundle.files.length,artifactBytes:bundle.size,uploadFiles:bundle.files.map(f=>f.file),excludedFiles:bundle.excluded,reason:'直接上传所选静态网页目录，不运行构建。HTML、浏览器 JavaScript 和资源会提供给平台及玩家；纯 HTML/JS 项目的这些文件本身就是可发布代码。请确认文件清单不含私密内容。'};}catch(error){return unsupported(error.message);}
  }
  return {...base,ready:true,build:{mode:plan.kind,script:plan.buildScript,output:plan.outputDirectory||'<temporary-directory>',location:'local',upload:'web output only'},reason:'发布时在本地运行项目构建脚本，只上传网页产物（最多 3 MB、300 个文件），不上传项目源码树、依赖或 source map。请先安装项目依赖。网页 JavaScript 和资源仍可被平台及玩家读取。检查本身不会执行脚本。'};
}
