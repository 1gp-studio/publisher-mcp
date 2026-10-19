import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,mkdir,rm,symlink,readdir } from 'node:fs/promises';
import { join,dirname,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildVercelGame,convertRewrites } from '../src/vercel-build.js';
import { inspectGame } from '../src/inspect.js';

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
