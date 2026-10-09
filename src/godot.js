import { readFile,readdir,lstat,realpath } from 'node:fs/promises';
import { join,dirname,basename,relative,isAbsolute,sep,win32 } from 'node:path';
import { createHash } from 'node:crypto';

// Files a Godot web export ships besides the engine wasm.
const exportTypes=/\.(?:html|js|pck|png|ico|svg|json|txt)$/i;
const LIMIT=3*1024*1024;  // the export's own files; the server allows the same

// export_path of the first preset whose platform is Web (export_presets.cfg is data, not code).
export function webExportPath(presets) {
  for(const section of presets.split(/^\[preset\.\d+\]\s*$/m).slice(1)) {
    const head=section.split(/^\[preset\.\d+\.options\]\s*$/m)[0];
    if(!/^platform="Web"\s*$/m.test(head))continue;
    const match=head.match(/^export_path="([^"]*)"\s*$/m);
    if(match&&match[1])return match[1];
  }
  return null;
}

// Newest modification time among project sources, skipping the export itself,
// hidden folders (.godot import cache, .git) and anything Godot ignores (.gdignore).
async function newestSource(root,skip) {
  let newest=0,visited=0;
  async function walk(dir) {
    const entries=await readdir(dir,{withFileTypes:true});
    if(dir!==root&&entries.some(e=>e.name==='.gdignore'))return;
    for(const entry of entries) {
      if(++visited>20000)return;
      if(entry.name.startsWith('.'))continue;
      const path=join(dir,entry.name);
      if(path===skip)continue;
      if(entry.isDirectory()){await walk(path);continue;}
      if(entry.isFile())newest=Math.max(newest,(await lstat(path)).mtimeMs);
    }
  }
  await walk(root);
  return newest;
}

// Read the Web export of a Godot project: everything but the engine wasm is
// uploaded; the wasm is identified by SHA-1 and attached by the platform.
// Never runs Godot; the user (or agent) exports first.
export async function bundleGodotExport(projectDirectory) {
  const root=await realpath(projectDirectory);
  let presets;
  try{presets=await readFile(join(root,'export_presets.cfg'),'utf8');}
  catch{throw new Error('UNSUPPORTED_BUILD: 没有 export_presets.cfg。请在 Godot 中添加 Web 导出预设（单线程），导出一次后再发布。');}
  const path=webExportPath(presets);
  if(!path)throw new Error('UNSUPPORTED_BUILD: 导出预设中没有 Web 平台。请在 Godot 中添加 Web 导出预设（单线程）。');
  // Godot presets may come from Windows even when this client runs elsewhere.
  const rel=path.replace(/\\/g,'/').replace(/^res:\/\//,'');
  if(!rel||isAbsolute(rel)||win32.isAbsolute(rel)||/^[A-Za-z]:/.test(rel)||rel.split('/').includes('..'))throw new Error('UNSUPPORTED_BUILD: Web 导出路径必须位于项目目录内。');
  if(basename(rel)!=='index.html')throw new Error('UNSUPPORTED_BUILD: Web 导出文件名需为 index.html。');
  let dir;
  try{dir=await realpath(dirname(join(root,rel)));}
  catch{throw new Error(`UNSUPPORTED_BUILD: 还没有网页导出（${rel}）。请先在 Godot 中导出 Web 版本。`);}
  // A directory junction/symlink can escape the project without any '..' in the preset.
  const exportRelative=relative(root,dir);
  if(exportRelative==='..'||exportRelative.startsWith(`..${sep}`)||isAbsolute(exportRelative))throw new Error('UNSUPPORTED_BUILD: Web 导出路径必须位于项目目录内。');
  const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  const files=[];let size=0,runtime=null,pckTime=0;
  for(const entry of entries) {
    // Godot names every file of the export after its page (index.js, index.pck, index.wasm…);
    // anything else in the folder is not part of it and is never uploaded
    if(!entry.name.startsWith('index.'))continue;
    const file=join(dir,entry.name),stat=await lstat(file);
    if(stat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 导出目录中不支持符号链接。');
    if(!stat.isFile())continue;
    if(entry.name.endsWith('.wasm')) {
      if(runtime)throw new Error('UNSUPPORTED_BUILD: 导出目录中有多个 wasm（GDExtension 暂不支持）。');
      const bytes=await readFile(file);
      runtime={file:entry.name,sha:createHash('sha1').update(bytes).digest('hex'),size:bytes.length};
      continue;
    }
    if(!exportTypes.test(entry.name))continue;
    if(entry.name.endsWith('.pck'))pckTime=Math.max(pckTime,stat.mtimeMs);
    if(size+stat.size>LIMIT||files.length>=300)throw new Error('UNSUPPORTED_BUILD: 网页导出（不含引擎 wasm）超过 3 MB 或 300 个文件。超出时可把导出部署到别处，用 publish_link 发布网址。');
    const bytes=await readFile(file);size+=bytes.length;
    if(size>LIMIT)throw new Error('UNSUPPORTED_BUILD: 网页导出（不含引擎 wasm）超过 3 MB。');
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(bytes.toString('utf8')))throw new Error('POTENTIAL_SECRET: 导出内容疑似包含凭证，请移除后再发布。');
    files.push({file:entry.name,data:bytes.toString('base64'),encoding:'base64'});
  }
  if(!files.some(f=>f.file==='index.html')||!pckTime||!runtime)throw new Error('UNSUPPORTED_BUILD: 网页导出不完整（需要 index.html、.pck 和 .wasm）。请重新导出 Web 版本。');
  return {
    projectId:createHash('sha256').update(root).digest('hex').slice(0,32),
    files,size,runtime,exportDirectory:relative(root,dir)||'.',
    stale:(await newestSource(root,dir))>pckTime,
  };
}
