import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectGame } from '../src/inspect.js';
import { bundleGame } from '../src/bundle.js';
import { Platform } from '../src/platform.js';
async function fixture(t,files) {
  const dir=await mkdtemp(join(tmpdir(),'1gp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,value] of Object.entries(files))await writeFile(join(dir,name),value);
  return dir;
}
const web={'package.json':JSON.stringify({name:'test-game',description:'A game',scripts:{build:'vite build'},devDependencies:{vite:'7'}}),'package-lock.json':'{}','index.html':'<div>game</div>'};
test('Godot and non-Vite projects return unsupported before executing anything',async t=>{
  const dir=await fixture(t,{'project.godot':'config_version=5',...web});
  const info=await inspectGame(dir);assert.equal(info.supported,false);assert.equal(info.code,'UNSUPPORTED_BUILD');assert.match(info.reason,/Godot/);
  assert.equal(info.engine,'godot');assert.equal(info.alternative,'publish_link');
  const other=await fixture(t,{'package.json':'{"scripts":{"build":"next build"}}'});assert.equal((await inspectGame(other)).supported,false);
});
test('local Vite projects publish without GitHub or a git commit',async t=>{
  const dir=await fixture(t,web);const info=await inspectGame(dir);
  assert.equal(info.ready,true);assert.equal(info.source,'local');assert.equal(info.buildMethod,'web-npm');assert.equal(info.fileCount,3);
  await writeFile(join(dir,'index.html'),'modified');assert.equal((await inspectGame(dir)).ready,true);
});
test('source bundles omit env files and reject leaked private keys',async t=>{
  const dir=await fixture(t,{...web,'.env.local':'SECRET=never-upload','credentials.json':'private','asset.png':'binary'});
  const bundle=await bundleGame(dir);assert.equal(bundle.files.some(f=>f.file.startsWith('.env')||f.file==='credentials.json'),false);assert.equal(bundle.files.some(f=>f.file==='asset.png'),true);
  await writeFile(join(dir,'config.js'),'-----BEGIN PRIVATE KEY-----');assert.equal((await inspectGame(dir)).code,'POTENTIAL_SECRET');
});
test('pairing exposes only a hash, stores private token, and authenticates API requests',async t=>{
  let seen;
  const http=createServer((req,res)=>{seen=req.headers.authorization;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connected:true}));});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const dir=await fixture(t,{}),platform=new Platform({origin:`http://127.0.0.1:${http.address().port}`,configDirectory:dir});
  const result=await platform.connect();const token=await platform.token();
  assert.ok(token);assert.equal(JSON.stringify(result).includes(token),false);assert.equal(new URL(result.authorizationUrl).searchParams.get('challenge'),createHash('sha256').update(token).digest('hex'));assert.equal((await stat(platform.file)).mode&0o777,0o600);
  assert.equal((await platform.connect()).connected,true);assert.equal(seen,`Bearer ${token}`);
});
test('Godot metadata is read from project.godot as plain data',async t=>{
  const dir=await fixture(t,{'project.godot':'[application]\nconfig/name="Ink \\"Blade\\""\nconfig/description="Hero defense"\n'});
  const info=await inspectGame(dir);assert.equal(info.title,'Ink "Blade"');assert.equal(info.description,'Hero defense');
});
test('publish_link posts an external URL with the client token and returns the game page',async t=>{
  let seen,body;
  const http=createServer((req,res)=>{seen=req.headers.authorization;let text='';req.on('data',c=>text+=c);req.on('end',()=>{body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({slug:'game-abc',state:'ready',path:'/games/game-abc'}));});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{}),game=await fixture(t,{'project.godot':'config/name="dgame"\nconfig/description="Ink hero defense"\n'});
  // the server runs with HOME=config, so its credential lives in config/.config/1gp-studio
  const token='a'.repeat(64);const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  const {writeFile:write,mkdir}=await import('node:fs/promises');await mkdir(platform.directory,{recursive:true,mode:0o700});await write(platform.file,JSON.stringify({token}),{mode:0o600});
  const client=new Client({name:'1gp-link-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config},stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  const bad=await client.callTool({name:'publish_link',arguments:{url:'http://example.com/game/'}});
  assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).code,'INVALID_URL');
  const result=await client.callTool({name:'publish_link',arguments:{url:'https://example.github.io/dgame/',project_directory:game}});
  const data=JSON.parse(result.content[0].text);
  assert.equal(seen,`Bearer ${token}`);assert.deepEqual(body,{source:'external',url:'https://example.github.io/dgame/',title:'dgame',description:'Ink hero defense'});
  assert.equal(data.gameUrl,`${origin}/games/game-abc`);
});
async function godotFixture(t) {
  const {mkdir,utimes}=await import('node:fs/promises');
  const dir=await fixture(t,{'project.godot':'[application]\nconfig/name="dgame"\nconfig/description="Ink hero defense"\n',
    'export_presets.cfg':'[preset.0]\n\nname="Web"\nplatform="Web"\nexport_path="build/web/index.html"\n\n[preset.0.options]\n\nvariant/thread_support=false\n'});
  await mkdir(join(dir,'scripts'));await writeFile(join(dir,'scripts','main.gd'),'extends Node');
  await mkdir(join(dir,'build','web'),{recursive:true});
  for(const [name,value] of Object.entries({'index.html':'<canvas></canvas>','index.js':'engine','index.pck':'pack','index.wasm':'engine wasm'}))await writeFile(join(dir,'build','web',name),value);
  const old=new Date(Date.now()-60000);await utimes(join(dir,'scripts','main.gd'),old,old);await utimes(join(dir,'project.godot'),old,old);await utimes(join(dir,'export_presets.cfg'),old,old);
  return dir;
}
test('Godot web exports are published without the engine wasm',async t=>{
  const dir=await godotFixture(t);
  const info=await inspectGame(dir);
  assert.equal(info.supported,true);assert.equal(info.ready,true);assert.equal(info.buildMethod,'godot-web');assert.equal(info.title,'dgame');
  assert.equal(info.fileCount,3);assert.equal(info.build.engineSha1,createHash('sha1').update('engine wasm').digest('hex'));
  const {bundleGodotExport}=await import('../src/godot.js');
  const bundle=await bundleGodotExport(dir);
  assert.deepEqual(bundle.files.map(f=>f.file),['index.html','index.js','index.pck']);assert.deepEqual(bundle.runtime,{file:'index.wasm',sha:info.build.engineSha1,size:11});
  await writeFile(join(dir,'scripts','main.gd'),'extends Node # edited after export');
  const stale=await inspectGame(dir);assert.equal(stale.ready,false);assert.match(stale.reason,/重新导出/);
});
test('Godot exports up to 3 MB (without the engine) are bundled, larger ones refused',async t=>{
  const dir=await godotFixture(t);
  const {bundleGodotExport}=await import('../src/godot.js');
  await writeFile(join(dir,'build','web','index.pck'),Buffer.alloc(2.5*1024*1024));
  assert.equal((await bundleGodotExport(dir)).files.length,3);
  await writeFile(join(dir,'build','web','index.pck'),Buffer.alloc(3*1024*1024));
  await assert.rejects(bundleGodotExport(dir),/3 MB/);
});
test('Godot exports upload only their own files and must stay inside the project',async t=>{
  const dir=await godotFixture(t);
  const {bundleGodotExport}=await import('../src/godot.js');
  const {mkdir,rename,symlink}=await import('node:fs/promises');
  await writeFile(join(dir,'build','web','credentials.json'),'{"key":"x"}');await writeFile(join(dir,'build','web','notes.txt'),'private');
  assert.deepEqual((await bundleGodotExport(dir)).files.map(f=>f.file),['index.html','index.js','index.pck']);
  const outside=await mkdtemp(join(tmpdir(),'1gp-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await rename(join(dir,'build'),join(outside,'build'));await symlink(join(outside,'build'),join(dir,'build'));
  await assert.rejects(bundleGodotExport(dir),/项目目录内/);
  await rm(join(dir,'build'));await mkdir(join(dir,'build'));
  await writeFile(join(dir,'export_presets.cfg'),'[preset.0]\n\nname="Web"\nplatform="Web"\nexport_path="..\\\\web\\\\index.html"\n');
  await assert.rejects(bundleGodotExport(dir),/项目目录内/);
});
test('Godot projects without a web export explain how to export',async t=>{
  const dir=await fixture(t,{'project.godot':'config/name="g"\n'});
  const info=await inspectGame(dir);assert.equal(info.supported,false);assert.match(info.reason,/Web 导出预设/);
});
test('publish_game sends a Godot export with the engine reference',async t=>{
  let body;
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',slug:'g',state:'queued',path:'/games/g'}));});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{}),game=await godotFixture(t);
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  const {mkdir}=await import('node:fs/promises');await mkdir(platform.directory,{recursive:true,mode:0o700});await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-godot-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config},stderr:'pipe'}));t.after(()=>client.close());
  const result=await client.callTool({name:'publish_game',arguments:{project_directory:game}});
  assert.equal(result.isError,false);
  assert.equal(body.buildMethod,'godot-web');assert.equal(body.title,'dgame');assert.equal(body.files.some(f=>f.file.endsWith('.wasm')),false);
  assert.deepEqual(body.runtime,{file:'index.wasm',sha:createHash('sha1').update('engine wasm').digest('hex'),size:11});
});
test('actual MCP stdio transport exposes the tools and rejects unsupported projects',async t=>{
  const dir=await fixture(t,{'project.godot':'config_version=5'});
  const client=new Client({name:'1gp-integration-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['connect_platform','get_publish_status','inspect_game','publish_game','publish_link']);
  const result=await client.callTool({name:'publish_game',arguments:{project_directory:dir}});
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'UNSUPPORTED_BUILD');
});
