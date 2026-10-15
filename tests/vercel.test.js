import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,mkdir,symlink,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectGame } from '../src/inspect.js';
import { bundleGame } from '../src/bundle.js';
import { bundleVercelGame } from '../src/vercel-output.js';
import { uploadVercelFiles } from '../src/vercel-upload.js';
import { Platform } from '../src/platform.js';

const prefix='.vercel/output/';
const functionConfig={runtime:'nodejs22.x',handler:'index.js',launcherType:'Nodejs'};
const gameFiles={
  'package.json':JSON.stringify({name:'complete-game',description:'Full game'}),
  [prefix+'config.json']:JSON.stringify({version:3,routes:[{src:'/api/state',dest:'/api/state'},{handle:'filesystem'},{src:'/(.*)',dest:'/index.html'}]}),
  [prefix+'static/index.html']:'<script src="/game.js"></script>',
  [prefix+'static/game.js']:'fetch("/api/state")',
  [prefix+'functions/api/state.func/.vc-config.json']:JSON.stringify(functionConfig),
  [prefix+'functions/api/state.func/index.js']:'module.exports = require("tiny-lib");',
  [prefix+'functions/api/state.func/node_modules/tiny-lib/package.json']:'{"main":"index.js"}',
  [prefix+'functions/api/state.func/node_modules/tiny-lib/index.js']:'module.exports = (req,res)=>res.end("ready");'
};
async function fixture(t,files=gameFiles) {
  const root=await mkdtemp(join(tmpdir(),'1gp-vercel-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,value] of Object.entries(files)){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),value);}
  return root;
}
function receipt(file) {
  const bytes=file.encoding==='base64-gzip'?gunzipSync(Buffer.from(file.data,'base64')):Buffer.from(file.data,'base64');
  return {file:file.file,sha:createHash('sha1').update(bytes).digest('hex'),size:bytes.length,receipt:'signed-test-receipt'};
}
test('auto-detection preserves routing, API function, config and runtime dependencies',async t=>{
  const root=await fixture(t);
  const info=await inspectGame(root);
  assert.equal(info.ready,true);assert.equal(info.buildMethod,'vercel-output');assert.equal(info.functionCount,1);
  assert.match(info.reason,/无需用户 Vercel/);
  const bundle=await bundleVercelGame(root);
  assert.deepEqual(new Set(bundle.files.map(file=>file.file)),new Set(Object.keys(gameFiles).filter(file=>file.startsWith(prefix))));
  assert.equal(bundle.projectId,info.projectId);
  await mkdir(join(root,'api'));await writeFile(join(root,'api/state.js'),'server implementation');
  assert.equal((await inspectGame(root)).ready,true,'server source can coexist with its complete output');
});
test('SSR-only game can use a root function without static index.html',async t=>{
  const root=await fixture(t,{
    [prefix+'config.json']:JSON.stringify({version:3,routes:[{src:'/(.*)',dest:'/render'}]}),
    [prefix+'functions/render.func/.vc-config.json']:JSON.stringify({...functionConfig,runtime:'nodejs24.x'}),
    [prefix+'functions/render.func/index.js']:'module.exports=(req,res)=>res.end("<h1>Game</h1>");'
  });
  const info=await inspectGame(root);assert.equal(info.ready,true);assert.equal(info.functionCount,1);
});
test('API and SSR detection never falls back to frontend-only success',async t=>{
  for(const server of ['api/state.js','server/index.js','src/app/api/state/route.ts']) {
    const root=await fixture(t,{'index.html':'frontend',[server]:'server code'});
    const info=await inspectGame(root);
    assert.equal(info.code,'VERCEL_OUTPUT_REQUIRED',server);assert.equal(info.supported,false);
    assert.match(info.reason,/不要登录 Vercel/);
    await assert.rejects(()=>bundleGame(root),/VERCEL_OUTPUT_REQUIRED/);
  }
  const root=await fixture(t,{'package.json':'{"dependencies":{"next":"16"},"scripts":{"build":"next build"}}','out/index.html':'frontend'});
  assert.equal((await inspectGame(root,{outputDirectory:'out'})).code,'VERCEL_OUTPUT_REQUIRED');
  await writeFile(join(root,'next.config.mjs'),"export default {output: 'export'}");
  assert.equal((await inspectGame(root,{outputDirectory:'out'})).ready,true,'explicit static Next export remains compatible');
  for(const config of ["/* output: 'export' was disabled for SSR */ export default {}", "export default {description: \"output: 'export'\"}", "export default {output: 'export', ...serverConfig}", "const unused = {output: 'export'}; export default {}", "export default { nested: {output: 'export'} }"]) {
    await writeFile(join(root,'next.config.mjs'),config);
    assert.equal((await inspectGame(root,{outputDirectory:'out'})).code,'VERCEL_OUTPUT_REQUIRED',config);
  }
  await writeFile(join(root,'next.config.mjs'),"// Real static config\nconst config = {output: 'export', images: {unoptimized: true}}; export default config;");
  assert.equal((await inspectGame(root,{outputDirectory:'out'})).ready,true);
});
test('explicit full-game target with missing output gives local-build guidance',async t=>{
  const root=await fixture(t,{'package.json':'{"scripts":{"build:vercel":"node export.cjs"}}'});
  const info=await inspectGame(root,{deploymentTarget:'vercel'});
  assert.equal(info.code,'VERCEL_OUTPUT_REQUIRED');assert.equal(info.ready,false);
  assert.deepEqual(info.scripts,['build:vercel']);assert.match(info.reason,/\.vc-config/);
  assert.equal((await inspectGame(root,{deploymentTarget:'vercel',outputDirectory:'dist'})).supported,false);
});
test('invalid runtimes, missing handlers/configs and non-self-contained functions fail before upload',async t=>{
  const cases=[
    [{...functionConfig,runtime:'edge'},/Node|nodejs/],
    [{...functionConfig,handler:'missing.js'},/handler/],
    [{...functionConfig,handler:'../server.js'},/handler/],
    [{...functionConfig,filePathMap:{'index.js':'../../server.js'}},/自包含/],
  ];
  for(const [config,pattern] of cases) {
    const root=await fixture(t,{...gameFiles,[prefix+'functions/api/state.func/.vc-config.json']:JSON.stringify(config)});
    await assert.rejects(()=>bundleVercelGame(root),pattern);
  }
  const root=await fixture(t);await rm(join(root,prefix+'functions/api/state.func/.vc-config.json'));
  await assert.rejects(()=>bundleVercelGame(root),/缺少/);
  const missing=await fixture(t,{'api/state.js':'server',[prefix+'config.json']:'{"version":3}',[prefix+'static/index.html']:'front'});
  await assert.rejects(()=>bundleVercelGame(missing),/没有任何服务端函数/);
});
test('unsupported platform features fail explicitly rather than being discarded',async t=>{
  for(const config of [{version:2},{version:3,images:{}},{version:3,routes:[{src:'/(.*)',dest:'https://personal.vercel.app/'}]},{version:3,routes:[{src:'/(.*)',middlewarePath:'auth'}]}]) {
    const root=await fixture(t,{...gameFiles,[prefix+'config.json']:JSON.stringify(config)});
    await assert.rejects(()=>bundleVercelGame(root),/UNSUPPORTED_BUILD/);
  }
  const root=await fixture(t,{...gameFiles,[prefix+'functions/api/state.prerender-config.json']:'{"expiration":60}'});
  await assert.rejects(()=>bundleVercelGame(root),/prerender/);
});
test('safe internal function links materialize while external links, loops and credentials are rejected',async t=>{
  const root=await fixture(t),fn=join(root,prefix+'functions/api/state.func');
  await symlink(fn,join(root,prefix+'functions/other.func'),process.platform==='win32'?'junction':'dir');
  const bundle=await bundleVercelGame(root);assert.equal(bundle.functionCount,2);
  assert.ok(bundle.files.some(file=>file.file===prefix+'functions/other.func/node_modules/tiny-lib/index.js'));
  const outside=await fixture(t,{'leak.js':'private'});
  await symlink(join(outside,'leak.js'),join(fn,'leak.js'));
  await assert.rejects(()=>bundleVercelGame(root),/同一输出目录/);
  await rm(join(fn,'leak.js'));await symlink(fn,join(fn,'loop'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>bundleVercelGame(root),/循环/);
  await rm(join(fn,'loop'));await writeFile(join(fn,'.env.local'),'SECRET=value');
  await assert.rejects(()=>bundleVercelGame(root),/POTENTIAL_SECRET/);
});
test('full outputs exclude source maps and enforce size/config limits',async t=>{
  const root=await fixture(t,{...gameFiles,[prefix+'static/game.js.map']:'source',[prefix+'functions/api/state.func/index.js.map']:'source'});
  const bundle=await bundleVercelGame(root);assert.equal(bundle.excluded.length,2);assert.equal(bundle.files.some(file=>file.file.endsWith('.map')),false);
  await writeFile(join(root,prefix+'functions/api/state.func/huge.bin'),Buffer.alloc(16*1024*1024+1));
  await assert.rejects(()=>bundleVercelGame(root),/16 MiB/);
  await rm(join(root,prefix+'functions/api/state.func/huge.bin'));
  await writeFile(join(root,prefix+'config.json'),JSON.stringify({version:3,padding:'x'.repeat(100*1024)}));
  await assert.rejects(()=>bundleVercelGame(root),/100 KiB/);
});
test('local scripts produce fresh complete output without user Vercel credentials',async t=>{
  const root=await fixture(t,{
    'package.json':JSON.stringify({scripts:{'build:game':'node build.cjs'}}),
    'build.cjs':`const fs=require('node:fs');if(process.env.VERCEL_TOKEN||process.env.ONEGP_PLATFORM_URL)process.exit(42);fs.mkdirSync('.vercel/output/static',{recursive:true});fs.writeFileSync('.vercel/output/static/index.html','built');fs.writeFileSync('.vercel/output/config.json','{"version":3}');fs.writeFileSync('ran','yes');`
  });
  const options={deploymentTarget:'vercel',buildScript:'build:game'};
  assert.equal((await inspectGame(root,options)).ready,true);await assert.rejects(stat(join(root,'ran')));
  const previous=process.env.VERCEL_TOKEN;process.env.VERCEL_TOKEN='not-for-build';t.after(()=>{if(previous===undefined)delete process.env.VERCEL_TOKEN;else process.env.VERCEL_TOKEN=previous;});
  const bundle=await bundleVercelGame(root,options);assert.equal(bundle.files.length,2);
  await writeFile(join(root,'build.cjs'),'process.exit(0)');
  await assert.rejects(()=>bundleVercelGame(root,options),/未生成新的/);
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{'build:game':'npx vercel build'}}));
  assert.match((await inspectGame(root,options)).reason,/不能调用 Vercel CLI/);
});
test('upload batches stay bounded, gzip large files and preserve only configuration data in receipts',async()=>{
  const files=[
    {file:prefix+'config.json',data:Buffer.from('{"version":3}').toString('base64'),encoding:'base64'},
    ...[0,1,2].map(i=>({file:prefix+`static/${i}.bin`,data:randomBytes(1600*1024).toString('base64'),encoding:'base64'})),
    {file:prefix+'static/compressed.bin',data:Buffer.alloc(3*1024*1024).toString('base64'),encoding:'base64'}
  ];
  const calls=[];
  const refs=await uploadVercelFiles({request:async(path,{body})=>{calls.push({path,body});return {files:body.files.map(receipt)};}},files);
  assert.ok(calls.length>1);assert.ok(calls.every(call=>Buffer.byteLength(JSON.stringify(call.body))<=4*1024*1024));
  assert.ok(calls.every(call=>call.path==='/api/publish/vercel/files'));
  assert.equal(calls.flatMap(call=>call.body.files).find(file=>file.file.endsWith('compressed.bin')).encoding,'base64-gzip');
  assert.equal(refs[0].data,files[0].data);assert.equal(refs.slice(1).some(file=>Object.hasOwn(file,'data')),false);
});
test('upload failures and invalid receipts are never retried',async()=>{
  const file={file:prefix+'static/index.html',data:Buffer.from('game').toString('base64'),encoding:'base64'};
  let calls=0;
  await assert.rejects(()=>uploadVercelFiles({request:async()=>{calls++;return {code:'NETWORK_ERROR',error:'uncertain'};}},[file]),/NETWORK_ERROR/);
  assert.equal(calls,1);
  await assert.rejects(()=>uploadVercelFiles({request:async()=>({files:[{...receipt(file),sha:'bad'}]})},[file]),/回执无效/);
  await assert.rejects(()=>uploadVercelFiles({request:async()=>{throw new Error('must not upload');}},[{...file,data:randomBytes(4*1024*1024).toString('base64')}]),/没有上传任何文件/);
  await assert.rejects(()=>uploadVercelFiles({request:async()=>{throw new Error('must not upload');}},[file],{release:{notes:'x'.repeat(4300*1024)}}),/4300 KiB.*没有上传任何文件/);
});
test('MCP publishes whole games with receipts, unchanged release/gameSlug and no cloud credentials',async t=>{
  const calls=[];let rejectUpload=false;
  const http=createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
    const body=JSON.parse(text);calls.push({path:req.url,body,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');
    if(req.url==='/api/publish/vercel/files')res.end(JSON.stringify(rejectUpload?{code:'NETWORK_ERROR',error:'uncertain'}:{files:body.files.map(receipt)}));
    else res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',path:'/games/original',state:'queued'}));
  });});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{}),root=await fixture(t);
  for(let index=0;index<205;index++)await writeFile(join(root,prefix+`static/asset-${index}.txt`),'asset');
  const platform=new Platform({origin,configDirectory:join(config,'.config/1gp-studio')});await mkdir(platform.directory,{recursive:true});await writeFile(platform.file,JSON.stringify({token:'a'.repeat(64)}));
  const client=new Client({name:'complete-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'}));t.after(()=>client.close());
  const release={version:'1.0.0',title:'First game',notes:'Initial playable game',changeType:'minor'};
  const args={project_directory:root,deployment_target:'vercel',gameSlug:'original',release};
  const published=await client.callTool({name:'publish_game',arguments:args});assert.equal(published.isError,false,JSON.stringify(published));
  assert.equal(calls.length,3);assert.equal(calls[0].body.files.length,200);assert.equal(calls[1].path,'/api/publish/vercel/files');const body=calls[2].body;
  assert.equal(body.buildMethod,'vercel-output');assert.equal(body.source,'local');assert.equal(body.gameSlug,'original');assert.equal(body.release.version,'1.0.0');
  assert.ok(body.files.every(file=>file.receipt));assert.ok(body.files.some(file=>file.file.includes('/node_modules/')));
  assert.equal(body.files.find(file=>file.file.endsWith('/index.js')).data,undefined);
  assert.ok(body.files.find(file=>file.file.endsWith('/.vc-config.json')).data);
  assert.equal(body.files.some(file=>Object.hasOwn(file,'encoding')),false,'receipt protocol has no encoding property');
  assert.ok(calls.every(call=>call.authorization==='Bearer '+'a'.repeat(64)));
  rejectUpload=true;const failed=await client.callTool({name:'publish_game',arguments:args});assert.equal(failed.isError,true);assert.equal(calls.length,4,'failed upload never proceeds to deploy or retries');
});
