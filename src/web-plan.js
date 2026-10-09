import { lstat,readFile } from 'node:fs/promises';
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
  if(buildScript!==undefined&&(!/^[A-Za-z0-9:_-]{1,80}$/.test(buildScript)||typeof pkg?.scripts?.[buildScript]!=='string'||!pkg.scripts[buildScript].trim()))throw new Error('UNSUPPORTED_BUILD: build_script 必须是 package.json 中已有的 npm 脚本名称。');
  if(outputDirectory!==undefined) {
    const output=await outputPath(root,outputDirectory,{building:!!buildScript});
    if(output===root&&pkg&&Object.keys(pkg.scripts||{}).some(k=>/build|export/.test(k)))throw new Error('UNSUPPORTED_BUILD: 有构建脚本的项目请指定独立产物目录，不能上传项目根目录。');
    return {kind:buildScript?'custom':'prebuilt',pkg,output,outputDirectory,buildScript};
  }
  if(buildScript)throw new Error('UNSUPPORTED_BUILD: 运行自定义构建脚本时必须提供 output_directory。');
  if((pkg?.dependencies?.vite||pkg?.devDependencies?.vite)&&typeof pkg.scripts?.build==='string'&&pkg.scripts.build.trim())return {kind:'vite',pkg,buildScript:'build'};
  if(!pkg) {
    try{const stat=await lstat(join(root,'index.html'));if(stat.isFile()&&!stat.isSymbolicLink())return {kind:'prebuilt',pkg,output:root,outputDirectory:'.'};}catch{}
  }
  return {kind:'choose-output',pkg};
}
