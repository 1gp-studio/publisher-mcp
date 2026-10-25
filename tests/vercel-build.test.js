import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,mkdir,rm,symlink,readdir,cp } from 'node:fs/promises';
import { join,dirname,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildVercelGame,convertRewrites } from '../src/vercel-build.js';
import { inspectGame } from '../src/inspect.js';
import { bundleVercelGame } from '../src/vercel-output.js';

const require=createRequire(import.meta.url);
const serverSource=`import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {z} from 'zod';
const websocket=new WebSocketServer({noServer:true});
const values=new Map<string,string>();
const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://local');const path=url.searchParams.get('__path')||url.pathname;
  if(path==='/healthz'){res.end('healthy');return;}
  if(path==='/api/whoami'){res.setHeader('content-type','application/json');res.end(JSON.stringify({game:'fixture',environment:process.env.USER_GAME_ENV,ws:!!websocket}));return;}
  if(path==='/api/kv'&&req.method==='POST'){let body='';for await(const part of req)body+=part;const data=z.object({key:z.string(),value:z.string()}).parse(JSON.parse(body));values.set(data.key,data.value);res.end('saved');return;}
  if(path==='/api/kv'){res.end(values.get(url.searchParams.get('key')||'')||'missing');return;}
  res.statusCode=404;res.end('unknown');
});
export default server;`;
async function fixture(t,extra={}) {
  const root=await mkdtemp(join(tmpdir(),'1gp-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files={
    'package.json':JSON.stringify({name:'adapter-game',type:'module',scripts:{build:'vite build'},devDependencies:{vite:'8.3.4'}}),
    'index.html':'<div id="game">Same origin game</div><script type="module" src="/main.ts"></script>',
    'main.ts':'fetch("/api/whoami").then(r=>r.json()).then(console.log);',
    'api/index.ts':serverSource,
    'api/nested/ping.ts':'export default function(_req:any,res:any){res.end("pong");}',
    'vercel.json':JSON.stringify({framework:'vite',rewrites:[{source:'/api/:path*',destination:'/api/index?__path=/api/:path*'},{source:'/healthz',destination:'/api/index?__path=/healthz'}],functions:{'api/**/*.ts':{maxDuration:300}}}),
    ...extra
  };
  for(const [name,value] of Object.entries(files)){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),value);}
  await symlink(resolve('node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  return root;
}

// Exercise the generated artifacts through a small same-origin deployment
// harness, including rewrite captures and the original request's query string.
async function serve(t,output) {
  const config=JSON.parse(await readFile(join(output,'config.json'),'utf8'));
  const http=createServer(async(req,res)=>{
    try {
      const original=new URL(req.url,'http://local');let target=original;
      for(const route of config.routes) {
        if(route.handle==='filesystem')break;
        const regex=new RegExp(route.src);if(!regex.test(original.pathname))continue;
        const rewritten=new URL(original.pathname.replace(regex,route.dest),'http://local');
        target=new URL(original);target.pathname=rewritten.pathname;for(const [key,value] of rewritten.searchParams)target.searchParams.set(key,value);break;
      }
      if(target.pathname.startsWith('/api/')) {
        const handler=require(join(output,'functions',target.pathname.slice(1)+'.func/index.cjs'));
        req.url=target.pathname+target.search;await handler(req,res);return;
      }
      res.end(await readFile(join(output,'static',target.pathname==='/'?'index.html':target.pathname.slice(1))));
    }catch{res.statusCode=500;res.end('deployment error');}
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  return `http://127.0.0.1:${http.address().port}`;
}

test('real Vite plus TypeScript API builds offline and serves frontend, health, GET and POST on one origin',async t=>{
  const root=await fixture(t),before=await readFile(join(root,'api/index.ts'),'utf8');
  const previous=process.env.USER_GAME_ENV;process.env.USER_GAME_ENV='PRIVATE_ENV_NOT_TO_BAKE';t.after(()=>{if(previous===undefined)delete process.env.USER_GAME_ENV;else process.env.USER_GAME_ENV=previous;});
  assert.equal((await inspectGame(root)).code,'VERCEL_OUTPUT_REQUIRED');
  const built=await buildVercelGame(root);assert.equal(built.ready,true);assert.equal(built.functionCount,2);assert.equal(built.vercel_output_directory,'.1gp/vercel-output');
  const output=join(root,built.vercel_output_directory),compiled=await readFile(join(output,'functions/api/index.func/module.cjs'),'utf8');
  assert.equal(compiled.includes('PRIVATE_ENV_NOT_TO_BAKE'),false);assert.ok(compiled.includes('process.env.USER_GAME_ENV'));
  assert.match(compiled,/Optional ws native accelerator/);
  assert.equal(await readFile(join(root,'api/index.ts'),'utf8'),before,'game source is unchanged');
  assert.equal((await readdir(root)).some(name=>name.startsWith('.1gp-vercel-build-')),false);
  assert.equal(JSON.parse(await readFile(join(output,'functions/api/index.func/.vc-config.json'),'utf8')).maxDuration,300);
  assert.equal(JSON.parse(await readFile(join(output,'functions/api/nested/ping.func/.vc-config.json'),'utf8')).maxDuration,300);
  const info=await inspectGame(root,{deploymentTarget:'vercel',vercelOutputDirectory:built.vercel_output_directory});assert.equal(info.ready,true);
  assert.equal((await inspectGame(root)).buildMethod,'vercel-output','a managed successful build is automatically found');
  const origin=await serve(t,output);
  assert.match(await(await fetch(origin)).text(),/Same origin game/);
  assert.equal(await(await fetch(origin+'/healthz')).text(),'healthy');
  const who=await(await fetch(origin+'/api/whoami')).json();assert.equal(who.game,'fixture');assert.equal(who.ws,true);
  const post=await fetch(origin+'/api/kv',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'state',value:'same-origin'})});assert.equal(post.status,200);assert.equal(await post.text(),'saved');
  assert.equal(await(await fetch(origin+'/api/kv?key=state')).text(),'same-origin','rewrite preserves the original query');
});

test('fixed nested req/res APIs work without rewrites and successful rebuild replaces only managed output',async t=>{
  const root=await fixture(t,{'vercel.json':'{}'});const first=await buildVercelGame(root);
  const origin=await serve(t,join(root,first.vercel_output_directory));assert.equal(await(await fetch(origin+'/api/nested/ping')).text(),'pong');
  await writeFile(join(root,'main.ts'),'console.log("second build")');await buildVercelGame(root);
  const saved=await readFile(join(root,'.1gp/vercel-output/config.json'),'utf8');
  await writeFile(join(root,'api/index.ts'),'export default function( { invalid syntax');
  await assert.rejects(()=>buildVercelGame(root),/LOCAL_BUILD_FAILED/);
  assert.equal(await readFile(join(root,'.1gp/vercel-output/config.json'),'utf8'),saved);
  assert.equal((await readdir(root)).some(name=>name.startsWith('.1gp-vercel-build-')),false);
  assert.equal((await readdir(join(root,'.1gp'))).includes('vercel-output.lock'),false);
});

test('managed output rejects changed source, translations and hidden build inputs before inspect or publish',async t=>{
  const root=await fixture(t,{'public/index.html':'<p>built</p>','locales/en.json':'{"title":"Game"}','.env.production':'VITE_TITLE=game','.swcrc':'{}','.browserslistrc':'defaults'});
  const options={frontendOutputDirectory:'public'};
  await buildVercelGame(root,options);
  const marker=JSON.parse(await readFile(join(root,'.1gp/vercel-output.owner.json'),'utf8'));
  assert.equal(marker.version,2);assert.match(marker.sourceFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(marker).includes('VITE_TITLE'),false,'only a combined hash is stored');
  await mkdir(join(root,'1gp-kit'),{recursive:true});await writeFile(join(root,'1gp-kit/cover.png'),'page-only change');
  await mkdir(join(root,'dist'),{recursive:true});await writeFile(join(root,'dist/index.html'),'unrelated output');
  assert.equal((await inspectGame(root)).ready,true,'promotion assets and unrelated generated output do not invalidate source');
  for(const file of ['main.ts','api/index.ts','locales/en.json','.env.production','.swcrc','.browserslistrc']) {
    const before=await readFile(join(root,file),'utf8');await writeFile(join(root,file),before+'\n');
    const inspected=await inspectGame(root);assert.equal(inspected.code,'VERCEL_OUTPUT_REQUIRED',file);assert.match(inspected.reason,/重新调用 build_vercel_game/);
    await assert.rejects(()=>bundleVercelGame(root),/VERCEL_OUTPUT_REQUIRED.*build_vercel_game/);
    await assert.rejects(()=>bundleVercelGame(root,{deploymentTarget:'vercel',vercelOutputDirectory:'.1gp/vercel-output'}),/VERCEL_OUTPUT_REQUIRED/);
    await writeFile(join(root,file),before);assert.equal((await inspectGame(root)).ready,true);
  }
  await writeFile(join(root,'new-level.json'),'[1,2]');assert.equal((await inspectGame(root)).code,'VERCEL_OUTPUT_REQUIRED');
  await buildVercelGame(root,options);assert.equal((await inspectGame(root)).ready,true,'a successful rebuild refreshes the fingerprint');
  await rm(join(root,'new-level.json'));assert.equal((await inspectGame(root)).code,'VERCEL_OUTPUT_REQUIRED','removed source also invalidates output');
});

test('legacy managed markers require a rebuild while explicit third-party prebuilt output keeps its semantics',async t=>{
  const root=await fixture(t,{'public/index.html':'<p>built</p>'});await buildVercelGame(root,{frontendOutputDirectory:'public'});
  const markerPath=join(root,'.1gp/vercel-output.owner.json'),marker=JSON.parse(await readFile(markerPath,'utf8'));
  await writeFile(markerPath,JSON.stringify({tool:marker.tool,version:1,projectId:marker.projectId}));
  assert.equal((await inspectGame(root)).code,'VERCEL_OUTPUT_REQUIRED');
  await assert.rejects(()=>bundleVercelGame(root,{vercelOutputDirectory:'.1gp/vercel-output'}),/没有源码指纹.*build_vercel_game/);
  await cp(join(root,'.1gp/vercel-output'),join(root,'third-party-output'),{recursive:true});
  await writeFile(join(root,'main.ts'),'console.log("changed after third-party export")');
  const explicit={deploymentTarget:'vercel',vercelOutputDirectory:'third-party-output'};
  assert.equal((await inspectGame(root,explicit)).ready,true);
  assert.equal((await bundleVercelGame(root,explicit)).functionCount,2);
  await cp(join(root,'third-party-output'),join(root,'.vercel/output'),{recursive:true});
  assert.equal((await inspectGame(root)).ready,true,'ordinary .vercel/output is still an explicit prebuilt contract');
});

test('prebuilt frontend files are fingerprinted even in a normally excluded build directory',async t=>{
  const root=await fixture(t,{'dist/index.html':'<p>existing export</p>'});
  await buildVercelGame(root,{frontendOutputDirectory:'dist'});assert.equal((await inspectGame(root)).ready,true);
  await writeFile(join(root,'dist/index.html'),'<p>new export</p>');
  assert.equal((await inspectGame(root)).code,'VERCEL_OUTPUT_REQUIRED');
});

test('reserved managed output fails closed when its owner marker is missing or invalid',async t=>{
  const root=await fixture(t,{'public/index.html':'<p>built</p>'});await buildVercelGame(root,{frontendOutputDirectory:'public'});
  const marker=join(root,'.1gp/vercel-output.owner.json'),saved=JSON.parse(await readFile(marker,'utf8'));
  await writeFile(join(root,'api/index.ts'),'export default function(_req:any,res:any){res.end("changed source");}');
  const selected={deploymentTarget:'vercel',vercelOutputDirectory:'.1gp/vercel-output'};
  for(const replacement of [null,'not json',JSON.stringify({...saved,projectId:'another-project'})]) {
    if(replacement===null)await rm(marker);else await writeFile(marker,replacement);
    const result=await inspectGame(root,selected);assert.equal(result.code,'VERCEL_OUTPUT_REQUIRED');assert.notEqual(result.ready,true);
    await assert.rejects(()=>bundleVercelGame(root,selected),/VERCEL_OUTPUT_REQUIRED.*build_vercel_game/);
  }
  if(await readFile(join(root,'.1gp/VERCEL-OUTPUT/config.json'),'utf8').catch(()=>null)) {
    assert.equal((await inspectGame(root,{vercelOutputDirectory:'.1gp/VERCEL-OUTPUT'})).code,'VERCEL_OUTPUT_REQUIRED','a case-insensitive path alias cannot bypass the reserved-directory check');
  }
  await cp(join(root,'.1gp/vercel-output'),join(root,'third-party-output'),{recursive:true});
  assert.equal((await inspectGame(root,{vercelOutputDirectory:'third-party-output'})).ready,true,'the reserved-path rule does not change third-party prebuilt output');
});

test('source changes during construction preserve previous output and its fingerprint',async t=>{
  const root=await fixture(t,{'public/index.html':'<p>previous output</p>'});await buildVercelGame(root,{frontendOutputDirectory:'public'});
  const output=join(root,'.1gp/vercel-output/static/index.html'),marker=join(root,'.1gp/vercel-output.owner.json');
  const previousOutput=await readFile(output,'utf8'),previousMarker=await readFile(marker,'utf8');
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',scripts:{build:'node build.mjs'},devDependencies:{vite:'8.3.4'}}));
  await writeFile(join(root,'build.mjs'),`import{writeFileSync}from'node:fs';writeFileSync('public/index.html','<p>new output</p>');writeFileSync('main.ts','console.log("source changed during build")');`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public',buildScript:'build'}),/LOCAL_BUILD_FAILED: 构建期间源码/);
  assert.equal(await readFile(output,'utf8'),previousOutput);assert.equal(await readFile(marker,'utf8'),previousMarker);
  assert.equal((await readdir(root)).some(name=>name.startsWith('.1gp-vercel-build-')),false);
  assert.equal((await readdir(join(root,'.1gp'))).includes('vercel-output.lock'),false);
});

test('a dedicated generated frontend directory does not invalidate its own successful build',async t=>{
  const root=await fixture(t,{
    'package.json':JSON.stringify({type:'module',scripts:{build:'node build.mjs'}}),
    'build.mjs':`import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('web-export',{recursive:true});writeFileSync('web-export/index.html','<p>generated frontend</p>');`,
    'vercel.json':'{}'
  });
  await buildVercelGame(root,{frontendOutputDirectory:'web-export',buildScript:'build'});
  assert.equal((await inspectGame(root)).ready,true);
  assert.equal((await bundleVercelGame(root)).functionCount,2);
});

test('unsupported config, dynamic API paths and import.meta never silently produce incomplete games',async t=>{
  for(const extra of [
    {'vercel.json':'{"headers":[{"source":"/(.*)","headers":[]}]}'},
    {'api/[id].ts':'export default ()=>{}'},
    {'api/index.ts':'export default function(req,res){res.end(import.meta.url)}'},
    {'vercel.json':'{"functions":{"api/index.ts":{"includeFiles":"data/**"}}}'},
  ]) {
    const root=await fixture(t,extra);await assert.rejects(()=>buildVercelGame(root),/UNSUPPORTED_BUILD|LOCAL_BUILD_FAILED/);
    assert.equal((await readdir(root)).some(name=>name.startsWith('.1gp-vercel-build-')),false);
  }
  assert.throws(()=>convertRewrites([{source:'/api/:id',destination:'/api/index'}]),/动态参数/);
});

test('adapter refuses unowned output and exposes a working MCP build tool without platform authorization',async t=>{
  const root=await fixture(t);await mkdir(join(root,'.1gp/vercel-output'),{recursive:true});await writeFile(join(root,'.1gp/vercel-output/keep.txt'),'user file');
  await assert.rejects(()=>buildVercelGame(root),/不会覆盖/);assert.equal(await readFile(join(root,'.1gp/vercel-output/keep.txt'),'utf8'),'user file');
  const clean=await fixture(t);
  const client=new Client({name:'adapter-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],stderr:'pipe'}));t.after(()=>client.close());
  assert.equal(client.getServerVersion().version,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
  const result=await client.callTool({name:'build_vercel_game',arguments:{project_directory:clean}});
  assert.equal(result.isError,false,JSON.stringify(result));const built=JSON.parse(result.content[0].text);assert.equal(built.vercel_output_directory,'.1gp/vercel-output');
  const checked=await client.callTool({name:'inspect_game',arguments:{project_directory:clean,deployment_target:built.deployment_target,vercel_output_directory:built.vercel_output_directory}});assert.equal(checked.isError,false);
});
test('functions that read files at run time are refused instead of shipping without those files',async t=>{
  const root=await fixture(t,{'public/index.html':'<p>built</p>','levels.json':'[1,2,3]','api/index.ts':'export default function(_req:any,res:any){res.end("ok");}',
    'api/nested/ping.ts':`import {readFileSync} from 'node:fs';export default function(_req:any,res:any){res.end(readFileSync(process.cwd()+'/levels.json','utf8'));}`});
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/在运行时读取文件/);
  // Other static filesystem imports are refused too, in the project and its dependencies.
  await writeFile(join(root,'api/nested/ping.ts'),`import {openSync,readSync} from 'node:fs';export default function(_req:any,res:any){const b=Buffer.alloc(9);readSync(openSync('levels.json','r'),b);res.end(b);}`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/在运行时读取文件/);
  // (A package folder outside the shared node_modules link, so the fixture never writes into it.)
  await mkdir(join(root,'lib/node_modules/levels-pkg'),{recursive:true});
  await writeFile(join(root,'lib/node_modules/levels-pkg/package.json'),JSON.stringify({name:'levels-pkg',main:'index.js'}));
  await writeFile(join(root,'lib/node_modules/levels-pkg/index.js'),`const fs=require('fs'),path=require('path');module.exports=()=>fs.readFileSync(path.join(__dirname,'data.json'),'utf8');`);
  await writeFile(join(root,'api/nested/ping.ts'),`import levels from '../../lib/node_modules/levels-pkg/index.js';export default function(_req:any,res:any){res.end(levels());}`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/在运行时读取文件/);
  // The path and reader may be in different dependency modules, and the reader may be aliased.
  await writeFile(join(root,'lib/node_modules/levels-pkg/index.js'),`const path=require('node:path'),load=require('./load.cjs');module.exports=()=>load(path.join(__dirname,'data.json'));`);
  await writeFile(join(root,'lib/node_modules/levels-pkg/load.cjs'),`const {readFileSync:load}=require('node:fs');module.exports=file=>load(file,'utf8');`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/load\.cjs.*node:fs.*无法确认产物完整/);
  await writeFile(join(root,'lib/node_modules/levels-pkg/load.cjs'),`const storage=require('node:fs/promises');module.exports=file=>storage.readFile(file,'utf8');`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/node:fs\/promises.*无法确认产物完整/);
  await writeFile(join(root,'lib/node_modules/levels-pkg/load.cjs'),`const {createRequire}=require('node:module');module.exports=file=>createRequire(file)('./data.json');`);
  await assert.rejects(()=>buildVercelGame(root,{frontendOutputDirectory:'public'}),/node:module.*无法确认产物完整/);
  // Importing the data bundles it, so the same function builds.
  await writeFile(join(root,'api/nested/ping.ts'),`import levels from '../../levels.json';export default function(_req:any,res:any){res.end(JSON.stringify(levels));}`);
  const built=await buildVercelGame(root,{frontendOutputDirectory:'public'});assert.equal(built.ready,true);
  const handler=require(join(root,built.vercel_output_directory,'functions/api/nested/ping.func/index.cjs'));
  handler({}, {end:value=>assert.equal(value,'[1,2,3]')});
});
