import { readFile,lstat,realpath } from 'node:fs/promises';
import { resolve,isAbsolute,join } from 'node:path';
import { bundleGame } from './bundle.js';
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
export async function inspectGame(projectDirectory) {
  if(!isAbsolute(projectDirectory))return unsupported('请提供当前游戏项目的绝对路径。');
  let directory;
  try{directory=await realpath(resolve(projectDirectory));}catch{return unsupported('无法读取项目目录。');}
  let godot=null;
  try{godot=await file(directory,'project.godot');}catch{}
  if(godot!==null)return inspectGodot(directory,godotMetadata(godot));
  let pkg;
  try{pkg=JSON.parse(await file(directory,'package.json'));}catch{return unsupported('缺少可读取的根目录 package.json 或 project.godot。支持 Vite / npm 网页游戏和 Godot 网页导出；Godot 项目请把 project_directory 指向含 project.godot 的目录。');}
  if(!(pkg.dependencies?.vite||pkg.devDependencies?.vite)||typeof pkg.scripts?.build!=='string'||!pkg.scripts.build.trim())return unsupported('只支持带有 Vite 依赖和 npm run build 脚本的 Web 项目，或 Godot 网页导出（目录中需有 project.godot）；暂不支持 Next.js 或其他引擎。');
  try{await file(directory,'index.html');await file(directory,'package-lock.json');}catch{return unsupported('根目录必须包含 index.html 和 package-lock.json，且不能是符号链接。');}
  let bundle;
  try{bundle=await bundleGame(directory);}catch(error){return unsupported(error.message);}
  return {supported:true,ready:true,buildMethod:'web-npm',source:'local',projectId:bundle.projectId,title:typeof pkg.name==='string'?pkg.name.replace(/^@[^/]+\//,'').slice(0,120)||'Untitled game':'Untitled game',description:typeof pkg.description==='string'&&pkg.description.trim()?pkg.description.trim().slice(0,2000):DEFAULT_DESCRIPTION,build:{install:'npm ci',command:'npm run build',output:'dist'},fileCount:bundle.files.length,sourceBytes:bundle.size,excludedFiles:bundle.excluded.slice(0,30),reason:'支持 Web / npm。直接上传当前项目源码，在隔离的 Vercel 项目构建，无需 GitHub 仓库。不会在本机执行项目脚本。'};
}
