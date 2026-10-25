import { test } from 'node:test';
import { testSymlink } from './helpers/symlink.js';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,stat,mkdir,readdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectGame } from '../src/inspect.js';
import { bundleGame,bundleOutput } from '../src/bundle.js';
import { bundleGodotExport } from '../src/godot.js';
import { Platform } from '../src/platform.js';
async function fixture(t,files) {
  const dir=await mkdtemp(join(tmpdir(),'1gp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,value] of Object.entries(files))await writeFile(join(dir,name),value);
  return dir;
}
const release={version:'1.0.0',title:'First release',notes:'Initial playable game',changeType:'minor'};
// Publishing tests exercise the real prepare_game -> register -> publish sequence over stdio.
// Keep workflow traffic out of artifact assertions, which inspect only actual deployment bodies.
function workflowResponse(req,res,input={}) {
  const path=new URL(req.url,'http://test'),slug=path.searchParams.get('slug');
  let body;
  if(path.pathname==='/api/developer/games/match') body=input.slug?{game:{slug:input.slug,title:'Game'}}:{matches:[]};
  else if(path.pathname==='/api/publish/releases/context') body={source:slug?'local':null,...(slug?{gameSlug:slug}:{}),previous:null};
  else if(path.pathname==='/api/developer/game-updates') body={created:true,update:{id:input.updateId,gameSlug:input.gameSlug??null,state:'open'}};
  else if(path.pathname.startsWith('/api/developer/game-materials/')) body={game:{id:'11111111-1111-4111-8111-111111111111',slug:path.pathname.split('/').at(-1)},original:{locale:'zh'},languages:[],covers:{}};
  else if(path.pathname.startsWith('/api/developer/game-integrations/')) body={game:{id:'11111111-1111-4111-8111-111111111111',slug:path.pathname.split('/').at(-1)},platformOrigin:'https://www.ai-made.games',cloudSaves:{enabled:false,schemaVersion:1},leaderboards:[]};
  else if(path.pathname.startsWith('/api/developer/text-source/')) body={config:null,engine:null,status:[],integration:{state:'not_verified',message:'Renderer integration needs verification'}};
  else return false;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));return true;
}
async function preparedRelease(client,projectDirectory,options={}) {
  const result=await client.callTool({name:'prepare_game',arguments:{project_directory:projectDirectory,...options}});
  assert.equal(result.isError,false,result.content[0].text);
  const prepared=JSON.parse(result.content[0].text);
  assert.match(prepared.updateId,/^[a-f0-9-]{36}$/);
  return {...release,updateId:prepared.updateId};
}
const web={'package.json':JSON.stringify({name:'test-game',description:'A game',scripts:{build:'vite build'},devDependencies:{vite:'7'}}),'package-lock.json':'{}','index.html':'<div>game</div>'};
test('Godot and non-Vite projects return unsupported before executing anything',async t=>{
  const dir=await fixture(t,{'project.godot':'config_version=5',...web});
  const info=await inspectGame(dir);assert.equal(info.supported,false);assert.equal(info.code,'UNSUPPORTED_BUILD');assert.match(info.reason,/Godot/);
  assert.equal(info.engine,'godot');assert.equal(info.alternative,'publish_link');
  const other=await fixture(t,{'package.json':'{"scripts":{"build":"next build"}}'});assert.equal((await inspectGame(other)).supported,false);assert.equal((await inspectGame(other)).code,'VERCEL_OUTPUT_REQUIRED');
});
test('local Vite projects publish without GitHub or a git commit',async t=>{
  const dir=await fixture(t,web);const info=await inspectGame(dir);
  assert.equal(info.ready,true);assert.equal(info.source,'local');assert.equal(info.buildMethod,'web-static');assert.equal(info.fileCount,undefined);
  await writeFile(join(dir,'index.html'),'modified');assert.equal((await inspectGame(dir)).ready,true);
});
test('inspection does not execute scripts; local builds upload only fresh output',async t=>{
  const dir=await fixture(t,{...web,'private.ts':'private-source-marker','.env.local':'SECRET=never-upload','build.cjs':`const fs=require('node:fs');const path=require('node:path');const out=process.argv[process.argv.indexOf('--outDir')+1];fs.writeFileSync('ran','yes');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.html'),'<script src="game.js"></script>');fs.writeFileSync(path.join(out,'game.js'),'console.log("built")');fs.writeFileSync(path.join(out,'game.js.map'),'private-source-marker');fs.writeFileSync(path.join(out,'private.ts'),'private-source-marker');`});
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'test',devDependencies:{vite:'7'},scripts:{build:'node build.cjs'}}));
  assert.equal((await inspectGame(dir)).ready,true);
  await assert.rejects(stat(join(dir,'ran')));
  const bundle=await bundleGame(dir);
  assert.deepEqual(bundle.files.map(f=>f.file),['game.js','index.html']);
  assert.equal(JSON.stringify(bundle.files).includes(Buffer.from('private-source-marker').toString('base64')),false);
  assert.equal((await readdir(dir)).some(n=>n.startsWith('.1gp-build-')),false);
  await writeFile(join(dir,'build.cjs'),'process.exit(1)');
  await assert.rejects(bundleGame(dir),/LOCAL_BUILD_FAILED/);
  assert.equal((await readdir(dir)).some(n=>n.startsWith('.1gp-build-')),false);
});
test('the store kit folder at the top is never uploaded with the game',async t=>{
  const dir=await fixture(t,{'index.html':'game'});
  await mkdir(join(dir,'1gp-kit'));await mkdir(join(dir,'levels/1gp-kit'),{recursive:true});
  await writeFile(join(dir,'1gp-kit/game.json'),'{}');await writeFile(join(dir,'1gp-kit/preview.webm'),'x'.repeat(4*1024*1024));await writeFile(join(dir,'levels/1gp-kit/a.json'),'{}');
  const bundle=await bundleOutput(dir,dir);
  assert.deepEqual(bundle.files.map(f=>f.file),['index.html','levels/1gp-kit/a.json']);
  assert.ok(bundle.excluded.includes('1gp-kit'));
});
test('output validation rejects inline maps, credentials and oversized exports',async t=>{
  const dir=await fixture(t,{'index.html':'game','game.js':'//# sourceMappingURL=data:application/json;base64,e30='});
  await assert.rejects(bundleOutput(dir,dir),/source map/);
  await writeFile(join(dir,'game.js'),'-----BEGIN PRIVATE KEY-----');
  await assert.rejects(bundleOutput(dir,dir),/POTENTIAL_SECRET/);
  await writeFile(join(dir,'game.js'),'x'.repeat(3*1024*1024));
  await assert.rejects(bundleOutput(dir,dir),/3 MB/);
});
test('output validation rejects file symbolic links',async t=>{
  const dir=await fixture(t,{'index.html':'game'});
  if(!await testSymlink(t,join(dir,'index.html'),join(dir,'game.js')))return;
  await assert.rejects(bundleOutput(dir,dir),/符号链接/);
});
test('pairing exposes only a hash, stores private token, and authenticates API requests',async t=>{
  let seen;
  const http=createServer((req,res)=>{seen=req.headers.authorization;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connected:true}));});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const dir=await fixture(t,{}),platform=new Platform({origin:`http://127.0.0.1:${http.address().port}`,configDirectory:dir});
  const result=await platform.connect();const token=await platform.token();
  assert.ok(token);assert.equal(JSON.stringify(result).includes(token),false);assert.equal(new URL(result.authorizationUrl).searchParams.get('challenge'),createHash('sha256').update(token).digest('hex'));if(process.platform!=='win32')assert.equal((await stat(platform.file)).mode&0o777,0o600);
  assert.equal((await platform.connect()).connected,true);assert.equal(seen,`Bearer ${token}`);
});
test('a saved sign-in from the earlier default address keeps working on the main domain',async t=>{
  const dir=await fixture(t,{}),old=new Platform({origin:'https://1gp-game-platform.vercel.app',configDirectory:dir});
  await writeFile(old.file,JSON.stringify({token:'b'.repeat(64)}));
  const platform=new Platform({configDirectory:dir});
  assert.equal(platform.origin,'https://www.aiwanna.games');assert.equal(await platform.token(),'b'.repeat(64));
  assert.equal(await new Platform({origin:'http://127.0.0.1:9',configDirectory:dir}).token(),null,'never sent to another platform');
  await writeFile(platform.file,JSON.stringify({token:'c'.repeat(64)}));assert.equal(await platform.token(),'c'.repeat(64),'a new sign-in wins');
});
test('game titles come from the page title before template and folder names',async t=>{
  const page=title=>`<!doctype html><title>${title}</title><body></body>`;
  assert.equal((await inspectGame(await fixture(t,{'index.html':page('点点 &amp; 星星')}))).title,'点点 & 星星');
  assert.equal((await inspectGame(await fixture(t,{'index.html':page('Vite + TS'),'package.json':JSON.stringify({name:'star-catcher'})}))).title,'star-catcher');
  const plain=await fixture(t,{'index.html':'<canvas></canvas>','package.json':JSON.stringify({name:'vite-project'})});
  assert.equal((await inspectGame(plain)).title,basename(plain),'the folder name over a template name');
});
test('Godot metadata is read from project.godot as plain data',async t=>{
  const dir=await fixture(t,{'project.godot':'[application]\nconfig/name="Ink \\"Blade\\""\nconfig/description="Hero defense"\n'});
  const info=await inspectGame(dir);assert.equal(info.title,'Ink "Blade"');assert.equal(info.description,'Hero defense');
});
test('publish_link posts an external URL with the client token and returns the game page',async t=>{
  let seen,body;
  const http=createServer((req,res)=>{seen=req.headers.authorization;let text='';req.on('data',c=>text+=c);req.on('end',()=>{if(workflowResponse(req,res,text?JSON.parse(text):{}))return;body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({slug:'game-abc',state:'ready',path:'/games/game-abc'}));});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{}),game=await fixture(t,{'project.godot':'config/name="dgame"\nconfig/description="Ink hero defense"\n'});
  // the server runs with HOME=config, so its credential lives in config/.config/1gp-studio
  const token='a'.repeat(64);const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  const {writeFile:write,mkdir}=await import('node:fs/promises');await mkdir(platform.directory,{recursive:true,mode:0o700});await write(platform.file,JSON.stringify({token}),{mode:0o600});
  const client=new Client({name:'1gp-link-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  const release=await preparedRelease(client,game);
  const missing=await client.callTool({name:'publish_link',arguments:{project_directory:game,url:'https://example.github.io/dgame/'}});
  assert.equal(JSON.parse(missing.content[0].text).code,'RELEASE_NOTES_REQUIRED');
  const bad=await client.callTool({name:'publish_link',arguments:{release,project_directory:game,url:'http://example.com/game/'}});
  assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).code,'INVALID_URL');
  const result=await client.callTool({name:'publish_link',arguments:{release,url:'https://example.github.io/dgame/',project_directory:game}});
  const data=JSON.parse(result.content[0].text);
  assert.equal(seen,`Bearer ${token}`);assert.deepEqual(body,{source:'external',release,url:'https://example.github.io/dgame/',title:'dgame',description:'Ink hero defense'});
  assert.equal(data.gameUrl,`${origin}/games/game-abc`);
  assert.equal(data.workflowComplete,false);assert.equal(data.gameSlug,'game-abc');assert.equal(data.materialStatus,'needs_verification');
  assert.match(data.nextSteps.join('\n'),/1gp-kit\/game\.json/);assert.match(data.nextSteps.join('\n'),/set_game_media/);
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
  await rename(join(dir,'build'),join(outside,'build'));await symlink(join(outside,'build'),join(dir,'build'),process.platform==='win32'?'junction':'dir');
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
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{if(workflowResponse(req,res,text?JSON.parse(text):{}))return;body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',slug:'g',state:'queued',path:'/games/g'}));});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{}),game=await godotFixture(t);
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  const {mkdir}=await import('node:fs/promises');await mkdir(platform.directory,{recursive:true,mode:0o700});await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-godot-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'}));t.after(()=>client.close());
  const release=await preparedRelease(client,game);
  const result=await client.callTool({name:'publish_game',arguments:{release,project_directory:game}});
  assert.equal(result.isError,false);
  assert.equal(body.buildMethod,'godot-web');assert.equal(body.title,'dgame');assert.equal(body.files.some(f=>f.file.endsWith('.wasm')),false);
  assert.deepEqual(body.runtime,{file:'index.wasm',sha:createHash('sha1').update('engine wasm').digest('hex'),size:11});
  assert.equal(Object.hasOwn(body,'gameSlug'),false,'existing Godot publishing omits an update target');
  const previousProjectId=body.projectId;
  const updateRelease=await preparedRelease(client,game,{gameSlug:'transferred-godot-game',new_update:true});
  const update=await client.callTool({name:'publish_game',arguments:{release:updateRelease,project_directory:game,gameSlug:'transferred-godot-game'}});
  assert.equal(update.isError,false);assert.equal(body.gameSlug,'transferred-godot-game');
  assert.equal(body.projectId,previousProjectId,'an explicit target does not rewrite the local project identity');
  assert.equal(body.buildMethod,'godot-web');assert.equal(body.runtime.file,'index.wasm');
});
test('actual MCP stdio transport exposes the tools and rejects unsupported projects',async t=>{
  const dir=await fixture(t,{'project.godot':'config_version=5'});
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{
    if(workflowResponse(req,res,text?JSON.parse(text):{}))return;
    assert.fail('Unsupported projects must not publish');
  });});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{});
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  await mkdir(platform.directory,{recursive:true});await writeFile(platform.file,JSON.stringify({token:'c'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-integration-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['approve_game_text_candidates','build_docker_image','build_vercel_game','check_game_languages','complete_game_update','configure_cloud_saves','configure_game_text_source','configure_leaderboard','connect_platform','delete_game_update','find_my_game','get_docker_upload_status','get_game_announcement','get_game_integrations','get_game_materials','get_game_text_source','get_game_text_status','get_game_updates','get_publish_status','get_publisher_info','inspect_game','prepare_game','prepare_release','publish_docker_game','publish_game','publish_game_announcement','publish_link','set_game_covers','set_game_details','set_game_media','update_github_game','upload_docker_image','upload_game_text','validate_game_text','wait_for_publish']);
  assert.deepEqual((await client.listPrompts()).prompts.map(p=>p.name).sort(), ['add_cloud_saves','add_leaderboard','choose_publish_path','make_game_multilingual','prepare_docker_publish','prepare_github_publish','publish_local_artifacts','update_game']);
  const githubPrompt = await client.getPrompt({name:'prepare_github_publish',arguments:{repo:'https://github.com/org/game',kind:'tag',ref:'v2.0',check_result:'缺少 package-lock.json'}});
  const promptText = githubPrompt.messages[0].content.text;
  assert.match(promptText,/v2.0/); assert.match(promptText,/缺少 package-lock.json/); assert.match(promptText,/保持此渠道/);
  const localPrompt = await client.getPrompt({name:'publish_local_artifacts'});
  assert.match(localPrompt.messages[0].content.text,/不让我回网页手动选文件/);
  const release=await preparedRelease(client,dir);
  const result=await client.callTool({name:'publish_game',arguments:{release,project_directory:dir}});
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'UNSUPPORTED_BUILD');
});

test('publish_game sends only local build output and never posts a failed build',async t=>{
  const bodies=[];
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{if(workflowResponse(req,res,text?JSON.parse(text):{}))return;bodies.push(JSON.parse(text));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',path:'/games/static',state:'queued'}));});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{});
  const game=await fixture(t,{...web,'private.ts':'PRIVATE_SOURCE_SENTINEL','build.cjs':`const fs=require('node:fs');const path=require('node:path');const out=process.argv[process.argv.indexOf('--outDir')+1];fs.writeFileSync(path.join(out,'index.html'),'built game');fs.writeFileSync(path.join(out,'game.js.map'),'PRIVATE_SOURCE_SENTINEL');`});
  await writeFile(join(game,'package.json'),JSON.stringify({name:'local-game',devDependencies:{vite:'7'},scripts:{build:'node build.cjs'}}));
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  await mkdir(platform.directory,{recursive:true,mode:0o700});await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-static-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'}));t.after(()=>client.close());
  const release=await preparedRelease(client,game);
  const result=await client.callTool({name:'publish_game',arguments:{release,project_directory:game}});
  assert.equal(result.isError,false);
  assert.equal(bodies.length,1);assert.equal(bodies[0].buildMethod,'web-static');
  assert.deepEqual(bodies[0].files,[{file:'index.html',data:Buffer.from('built game').toString('base64'),encoding:'base64'}]);
  await writeFile(join(game,'export.cjs'),`const fs=require('node:fs');fs.mkdirSync('site',{recursive:true});fs.writeFileSync('site/index.html','generic export');`);
  await writeFile(join(game,'package.json'),JSON.stringify({name:'local-game',devDependencies:{vite:'7'},scripts:{build:'node build.cjs','export:web':'node export.cjs'}}));
  const generic=await client.callTool({name:'publish_game',arguments:{release,project_directory:game,output_directory:'site',build_script:'export:web'}});
  assert.equal(generic.isError,false);assert.equal(bodies.length,2);
  assert.deepEqual(bodies[1].files,[{file:'index.html',data:Buffer.from('generic export').toString('base64'),encoding:'base64'}]);
  assert.equal(bodies[0].projectId,bodies[1].projectId);
  const prebuilt=await client.callTool({name:'publish_game',arguments:{release,project_directory:game,output_directory:'site'}});
  assert.equal(prebuilt.isError,false);assert.equal(bodies.length,3);
  await writeFile(join(game,'build.cjs'),'process.exit(1)');
  const failed=await client.callTool({name:'publish_game',arguments:{release,project_directory:game}});
  assert.equal(failed.isError,true);assert.equal(JSON.parse(failed.content[0].text).code,'LOCAL_BUILD_FAILED');
  assert.equal(bodies.length,3);
});

test('publish_game targets the same owned local game from different folders and never retries a rejected target',async t=>{
  const bodies=[];
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{
    if(workflowResponse(req,res,text?JSON.parse(text):{}))return;
    const body=JSON.parse(text);bodies.push(body);res.setHeader('Content-Type','application/json');
    if(body.gameSlug==='not-owned'){res.statusCode=403;res.end(JSON.stringify({code:'PUBLISH_FAILED',error:'只能更新自己拥有的本地游戏。'}));return;}
    const slug=body.gameSlug||'new-local-game';
    res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',slug,state:'queued',path:`/games/${slug}`}));
  });});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{});
  const original=await fixture(t,{'index.html':'original game'}),moved=await fixture(t,{'index.html':'updated game in another folder'});
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  await mkdir(platform.directory,{recursive:true,mode:0o700});await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-transfer-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'}));t.after(()=>client.close());
  const tools=(await client.listTools()).tools;
  const publish=tools.find(tool=>tool.name==='publish_game');
  assert.equal(publish.inputSchema.properties.gameSlug.type,'string');
  assert.equal(publish.inputSchema.required.includes('gameSlug'),false);
  assert.equal(Object.hasOwn(tools.find(tool=>tool.name==='publish_link').inputSchema.properties,'gameSlug'),false,'external links do not accept a local update target');
  const release=await preparedRelease(client,original);
  const first=await client.callTool({name:'publish_game',arguments:{release,project_directory:original}});
  assert.equal(first.isError,false);assert.equal(Object.hasOwn(bodies[0],'gameSlug'),false);
  for(const folder of [original,moved]){
    const folderRelease=await preparedRelease(client,folder,{gameSlug:'original-game-a1b2c3d4',new_update:true});
    const updated=await client.callTool({name:'publish_game',arguments:{release:folderRelease,project_directory:folder,gameSlug:'original-game-a1b2c3d4'}});
    assert.equal(updated.isError,false);
    assert.equal(JSON.parse(updated.content[0].text).gameUrl,`${origin}/games/original-game-a1b2c3d4`);
  }
  assert.equal(bodies[1].gameSlug,bodies[2].gameSlug);
  assert.notEqual(bodies[1].projectId,bodies[2].projectId,'moving folders still changes the legacy identity, while explicit target remains stable');
  assert.equal(bodies[2].buildMethod,'web-static');
  assert.deepEqual(bodies[2].files,[{file:'index.html',data:Buffer.from('updated game in another folder').toString('base64'),encoding:'base64'}]);
  for(const invalid of ['','../game','game/playing','Uppercase','-game','game--id','x'.repeat(201)]){
    const rejected=await client.callTool({name:'publish_game',arguments:{release,project_directory:moved,gameSlug:invalid}});
    assert.equal(rejected.isError,true,invalid);
  }
  assert.equal(bodies.length,3,'invalid targets are rejected before any upload');
  // Simulate ownership being revoked after a valid preparation/registration, at the publish endpoint.
  const deniedRelease=await preparedRelease(client,moved,{gameSlug:'not-owned',new_update:true});
  const denied=await client.callTool({name:'publish_game',arguments:{release:deniedRelease,project_directory:moved,gameSlug:'not-owned'}});
  assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).code,'PUBLISH_FAILED');
  assert.equal(bodies.length,4,'a rejected target never falls back to publishing a new game');
  assert.equal(bodies[3].gameSlug,'not-owned');
});


test('standalone HTML games package browser files without npm or Vite',async t=>{
  const dir=await fixture(t,{'index.html':'<script src="src/game.js"></script>','.env':'secret'});
  await mkdir(join(dir,'src'));await writeFile(join(dir,'src/game.js'),'console.log("game")');
  const info=await inspectGame(dir);
  assert.equal(info.ready,true);assert.equal(info.build.mode,'prebuilt');
  assert.deepEqual(info.uploadFiles,['index.html','src/game.js']);
  assert.deepEqual((await bundleGame(dir)).files.map(f=>f.file),info.uploadFiles);
});
test('framework-neutral output directories preserve project identity and exclude project files',async t=>{
  const dir=await fixture(t,{'package.json':JSON.stringify({name:'other-framework',scripts:{build:'unused'}}),'private.js':'PRIVATE'});
  for(const folder of ['dist','build','out','.output/public']) {
    await mkdir(join(dir,folder),{recursive:true});await writeFile(join(dir,folder,'index.html'),'export');
    const info=await inspectGame(dir,{outputDirectory:folder});assert.equal(info.ready,true);
    const bundle=await bundleGame(dir,{outputDirectory:folder});
    assert.deepEqual(bundle.files.map(f=>f.file),['index.html']);assert.equal(bundle.projectId,info.projectId);
  }
  assert.equal((await inspectGame(dir)).code,'OUTPUT_REQUIRED');
  assert.equal((await inspectGame(dir,{outputDirectory:'.'})).supported,false);
});
test('generic npm builds run their own script without Vite arguments and reject unchanged output',async t=>{
  const dir=await fixture(t,{'package.json':JSON.stringify({name:'custom',scripts:{'export:web':'node build.cjs'}}),'build.cjs':`const fs=require('node:fs');if(process.argv.length!==2)process.exit(2);fs.mkdirSync('site',{recursive:true});fs.writeFileSync('site/index.html','exported');`});
  const options={outputDirectory:'site',buildScript:'export:web'};
  assert.equal((await inspectGame(dir,options)).ready,true);
  await assert.rejects(stat(join(dir,'site')));
  assert.deepEqual((await bundleGame(dir,options)).files.map(f=>f.file),['index.html']);
  await writeFile(join(dir,'build.cjs'),'// no-op');
  await assert.rejects(bundleGame(dir,options),/未生成新的/);
  assert.equal((await bundleGame(dir,{outputDirectory:'site'})).files.length,1);
});
test('output selection rejects traversal, symlink ancestors, server output and shell commands',async t=>{
  const dir=await fixture(t,{'package.json':JSON.stringify({scripts:{build:'node build.cjs'}})});
  const outside=await fixture(t,{'index.html':'private'});await symlink(outside,join(dir,'linked'),process.platform==='win32'?'junction':'dir');
  for(const outputDirectory of ['../outside',outside,'linked','linked/subdir','.next','src','.git','node_modules'])assert.equal((await inspectGame(dir,{outputDirectory})).supported,false);
  for(const buildScript of ['build; echo secret','missing'])assert.equal((await inspectGame(dir,{outputDirectory:'dist',buildScript})).supported,false);
  assert.equal((await inspectGame(dir,{buildScript:'build'})).supported,false);
});


test('unbuilt TypeScript HTML entry points are not mistaken for playable static output',async t=>{
  const dir=await fixture(t,{'index.html':'<script type="module" src="./main.ts"></script>','main.ts':'const privateValue: number = 1;'});
  const info=await inspectGame(dir);assert.equal(info.supported,false);assert.match(info.reason,/未打包的本地脚本/);
});

test('Godot export paths reject traversal and absolute paths on every host OS',async t=>{
  const paths=['../other/index.html','..\\other\\index.html','res://..\\other\\index.html','/other/index.html','C:\\other\\index.html','C:other/index.html','\\\\server\\share\\index.html'];
  for(const path of paths) {
    const dir=await fixture(t,{'export_presets.cfg':`[preset.0]\nplatform="Web"\nexport_path="${path}"\n`});
    await assert.rejects(()=>bundleGodotExport(dir),/Web 导出路径必须位于项目目录内/,path);
  }
});
test('Godot accepts Windows separators for exports that stay inside the project',async t=>{
  const dir=await godotFixture(t);
  await writeFile(join(dir,'export_presets.cfg'),'[preset.0]\nplatform="Web"\nexport_path="build\\web\\index.html"\n');
  assert.deepEqual((await bundleGodotExport(dir)).files.map(file=>file.file),['index.html','index.js','index.pck']);
});
test('Godot rejects export directories and ancestor links that leave the project',async t=>{
  const outside=await godotFixture(t);
  for(const [target,exportPath] of [[join(outside,'build','web'),'linked/index.html'],[outside,'linked/build/web/index.html']]) {
    const dir=await fixture(t,{'export_presets.cfg':`[preset.0]\nplatform="Web"\nexport_path="${exportPath}"\n`});
    await symlink(target,join(dir,'linked'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>bundleGodotExport(dir),/Web 导出路径必须位于项目目录内/);
  }
});

test('Docker MCP publication requires a ready matching upload and sends no ECR credentials',async t=>{
  const bodies=[];let state='importing';
  const http=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{if(workflowResponse(req,res,text?JSON.parse(text):{}))return;res.setHeader('Content-Type','application/json');if(req.url.startsWith('/api/publish/docker/uploads/'))res.end(JSON.stringify({state,project:'game'}));else{bodies.push(JSON.parse(text));res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',path:'/games/docker',state:'queued'}));}});});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const origin=`http://127.0.0.1:${http.address().port}`,config=await fixture(t,{});
  const platform=new Platform({origin,configDirectory:join(config,'.config','1gp-studio')});
  await mkdir(platform.directory,{recursive:true,mode:0o700});await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
  const client=new Client({name:'1gp-docker-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:config,USERPROFILE:config},stderr:'pipe'}));t.after(()=>client.close());
  const game=await fixture(t,{'index.html':'Docker game'});
  const release=await preparedRelease(client,game,{docker_project:'game'});
  const args={project_directory:game,upload_id:'11111111-1111-4111-8111-111111111111',project:'game',title:'Docker game'};
  assert.equal((await client.callTool({name:'publish_docker_game',arguments:{...args,release}})).isError,true);assert.equal(bodies.length,0);
  state='ready';assert.equal((await client.callTool({name:'publish_docker_game',arguments:{...args,release,project:'other'}})).isError,true);assert.equal(bodies.length,0);
  const published=await client.callTool({name:'publish_docker_game',arguments:{...args,release}});assert.equal(published.isError,false);
  const {sourceFiles,...sentRelease}=bodies[0].release;assert.deepEqual(sentRelease,release);assert.deepEqual(Object.keys(sourceFiles),['index.html']);
  assert.deepEqual(bodies,[{source:'docker',release:{...release,sourceFiles},hosting:'ec2-docker',uploadId:args.upload_id,project:'game',title:'Docker game',description:''}]);
  assert.equal(JSON.parse(published.content[0].text).gameUrl,origin+'/games/docker');
});
