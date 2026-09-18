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
test('actual MCP stdio transport exposes four tools and rejects unsupported projects',async t=>{
  const dir=await fixture(t,{'project.godot':'config_version=5'});
  const client=new Client({name:'1gp-integration-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['connect_platform','get_publish_status','inspect_game','publish_game']);
  const result=await client.callTool({name:'publish_game',arguments:{project_directory:dir}});
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'UNSUPPORTED_BUILD');
});
