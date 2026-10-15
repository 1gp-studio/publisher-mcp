import { lstat,readdir,readFile,realpath } from 'node:fs/promises';
import { join,relative,sep } from 'node:path';
import { createHash } from 'node:crypto';
import { webPackage,outputPath,validateBuildScript,serverRequirements,fullGameGuidance } from './web-plan.js';
import { runBuild } from './bundle.js';
import { validateVercelOutputFile,validateVercelOutputFiles,VERCEL_OUTPUT_LIMITS } from './vercel-validation.js';

export const VERCEL_LIMITS={...VERCEL_OUTPUT_LIMITS,bytes:VERCEL_OUTPUT_LIMITS.totalBytes};
const fail=message=>{throw new Error('UNSUPPORTED_BUILD: '+message);};
export const isVercelConfig=file=>file==='.vercel/output/config.json'||/\.func\/\.vc-config\.json$/.test(file);
export function artifactErrorCode(error) {return /^(?:POTENTIAL_SECRET|LOCAL_BUILD_FAILED|VERCEL_OUTPUT_REQUIRED):/.test(error.message)?error.message.split(':')[0]:'UNSUPPORTED_BUILD';}

export async function planVercel(root,{deploymentTarget,vercelOutputDirectory,outputDirectory,buildScript}={}) {
  if(deploymentTarget!==undefined&&!['static','vercel'].includes(deploymentTarget))fail('deployment_target 必须为 static 或 vercel。');
  if(vercelOutputDirectory!==undefined&&(outputDirectory!==undefined||deploymentTarget==='static'))fail('vercel_output_directory 不能与 output_directory 或 deployment_target="static" 同时使用。');
  if(deploymentTarget==='vercel'&&outputDirectory!==undefined)fail('完整 Vercel 发布请使用 vercel_output_directory，静态发布才使用 output_directory。');
  const selected=deploymentTarget==='vercel'||vercelOutputDirectory!==undefined;
  let directory=vercelOutputDirectory||'.vercel/output';
  if(!selected&&(deploymentTarget==='static'||outputDirectory!==undefined||buildScript!==undefined))return null;
  let output=await outputPath(root,directory,{building:true});
  let config=await lstat(join(output,'config.json')).catch(()=>null);
  if(!config&&vercelOutputDirectory===undefined) {
    const marker=join(root,'.1gp/vercel-output.owner.json'),stat=await lstat(marker).catch(()=>null);
    if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size<1000) {
      let managed;try{managed=JSON.parse(await readFile(marker,'utf8')).projectId===createHash('sha256').update(root).digest('hex');}catch{}
      if(managed){directory='.1gp/vercel-output';output=await outputPath(root,directory,{building:true});config=await lstat(join(output,'config.json')).catch(()=>null);}
    }
  }
  if(!selected&&!config)return null;
  const pkg=await webPackage(root);validateBuildScript(pkg,buildScript);
  return {kind:buildScript?'custom':'prebuilt',pkg,output,outputDirectory:directory,buildScript,missing:!config&&!buildScript};
}

export async function bundleVercelOutput(root,output) {
  const stat=await lstat(output).catch(()=>null);
  if(!stat?.isDirectory()||stat.isSymbolicLink())throw new Error('VERCEL_OUTPUT_REQUIRED: '+fullGameGuidance);
  const actualOutput=await realpath(output),files=[],excluded=[];
  let size=0,visited=0;
  async function walk(path,rel='',ancestors=new Set()) {
    const real=await realpath(path),inside=relative(actualOutput,real);
    if(inside==='..'||inside.startsWith('..'+sep))fail('Vercel 产物中的符号链接必须指向同一输出目录内的运行文件。');
    const info=await lstat(real);
    if(info.isDirectory()) {
      if(ancestors.has(real))fail('Vercel 产物存在循环符号链接。');
      const chain=new Set(ancestors);chain.add(real);
      for(const entry of (await readdir(real,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
        if(++visited>50000)fail('Vercel 产物目录过大。');
        const name=rel?`${rel}/${entry.name}`:entry.name;
        if(!rel&&!['config.json','static','functions'].includes(entry.name)) {
          if(['cache','diagnostics','builds.json'].includes(entry.name)){excluded.push(name);continue;}
          fail(`Vercel 输出包含不支持的顶层文件 ${entry.name}；请选择仅含 config.json、static、functions 的完整产物。`);
        }
        if(/\.map$/i.test(entry.name)){excluded.push(name);continue;}
        if(name.length>1000||/[\\\x00-\x1f\x7f%?#:]/.test(name)||name.split('/').some(part=>part==='..'||part==='.'||!part))fail('Vercel 产物路径过长或不支持。');
        await walk(join(real,entry.name),name,chain);
      }
      return;
    }
    if(!info.isFile())fail('Vercel 产物只支持普通文件或指向输出内文件的符号链接。');
    if(info.size>VERCEL_LIMITS.fileBytes)fail('Vercel 单文件最多 16 MiB。');
    if(size+info.size>VERCEL_LIMITS.bytes||files.length>=VERCEL_LIMITS.files)fail('完整 Vercel 产物最多 64 MiB、10000 个文件。');
    const bytes=await readFile(real);size+=bytes.length;
    if(bytes.length>VERCEL_LIMITS.fileBytes||size>VERCEL_LIMITS.bytes)fail('Vercel 产物超过大小限制。');
    const file='.vercel/output/'+rel;
    try{validateVercelOutputFile(file,bytes);}catch(error){if(/凭据|私钥|凭证/.test(error.message))throw new Error(error.message.replace(/^UNSUPPORTED_BUILD:/,'POTENTIAL_SECRET:'));throw error;}
    files.push({file,data:bytes.toString('base64'),encoding:'base64'});
  }
  await walk(output);
  validateVercelOutputFiles(files);
  const functionRoots=new Set(files.map(file=>file.file.match(/^(\.vercel\/output\/functions\/(?:[^/]+\/)*[^/]+\.func)\//)?.[1]).filter(Boolean));
  const requirements=await serverRequirements(root,await webPackage(root));
  if(requirements.length&&!functionRoots.size)throw new Error(`VERCEL_OUTPUT_REQUIRED: ${fullGameGuidance} 当前输出没有任何服务端函数。`);
  return {projectId:createHash('sha256').update(root).digest('hex').slice(0,32),files,size,excluded,functionCount:functionRoots.size};
}

export async function bundleVercelGame(projectDirectory,options={}) {
  const root=await realpath(projectDirectory),plan=await planVercel(root,options);
  if(!plan||plan.missing)throw new Error('VERCEL_OUTPUT_REQUIRED: '+fullGameGuidance);
  if(plan.buildScript) {
    const configPath=join(plan.output,'config.json');
    const before=await lstat(configPath).catch(()=>null);
    await runBuild(root,plan.buildScript);
    await outputPath(root,plan.outputDirectory,{building:true});
    const after=await lstat(configPath).catch(()=>null);
    if(!after||before&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs)throw new Error('LOCAL_BUILD_FAILED: 构建未生成新的 Vercel config.json。请检查完整产物输出；如要发布已有产物，请省略 build_script。没有上传任何文件。');
  }
  return bundleVercelOutput(root,plan.output);
}
