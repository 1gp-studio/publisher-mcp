import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Platform } from '../src/platform.js';
import { checkGameLanguages,uploadGameText,siteLanguages,supportedGameLanguages,setGameDetails } from '../src/languages.js';
import { automaticPublishPrompt,localPublishPrompt,dockerPublishPrompt,multilingualPrompt,updateGamePrompt } from '../src/publishing-prompts.js';
import packageInfo from '../package.json' with { type: 'json' };

const targets=['zh','en','ja','ko','es'];
const compatible=['zh','zh-Hant','en','es','pt-BR','ja','ko','de','fr','ru'];
test('language check reads language files and ?lang= handling without running code',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'langs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'locales'));await writeFile(join(dir,'locales/zh-CN.json'),'{"start":"开始"}');await writeFile(join(dir,'locales/en.json'),'{"start":"Start"}');
 await writeFile(join(dir,'game.js'),"const lang=navigator.language;button.textContent=t('start');");
 const found=await checkGameLanguages(dir);
 assert.equal(found.multilingual,true);assert.deepEqual(found.languages.sort(),['en','zh']);
 assert.deepEqual(found.siteLanguages,targets);assert.deepEqual(found.supportedGameLanguages,compatible);
 assert.equal(found.signals.readsLangParam,false);assert.equal(found.signals.readsBrowserLanguage,true);
 assert.match(found.nextSteps[0],/\?lang=/);
 const plain=await mkdtemp(join(tmpdir(),'plain-'));t.after(()=>rm(plain,{recursive:true,force:true}));
 await writeFile(join(plain,'index.html'),'<button>开始游戏</button>');
 const none=await checkGameLanguages(plain);assert.equal(none.multilingual,false);assert.match(none.nextSteps[0],/要不要做成多语言/);
});

test('publishing prompts recommend only the five targets while retaining originals outside them',()=>{
 assert.deepEqual(siteLanguages,targets);assert.deepEqual(supportedGameLanguages,compatible);
 for(const prompt of [automaticPublishPrompt,localPublishPrompt,dockerPublishPrompt,multilingualPrompt,updateGamePrompt('my-game')]){
  assert.match(prompt,/check_game_languages/);
  assert.ok(prompt.includes(targets.join('、')));
  assert.match(prompt,/缺失或过期/);
  assert.match(prompt,/原始语言不在这五种中时保留原文/);
  assert.match(prompt,/已有其他语言/);
  assert.match(prompt,/五种目标语言的游戏名和简介/);
  assert.doesNotMatch(prompt,/(?:其余|其他|另外)\s*(?:9|九|4|四)\s*种/);
 }
});

test('MCP stdio keeps all ten game languages usable with five default targets and partial metadata',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mcp-languages-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'locales'));
 await writeFile(join(dir,'locales/ru.json'),JSON.stringify({start:'Начать'}));
 const calls=[];
 const status=compatible.map(locale=>({locale,state:'ready',total:1,done:1,missing:[],stale:[],edited:0}));
 const http=createServer((req,res)=>{
  let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
   calls.push({method:req.method,path:req.url,body:text?JSON.parse(text):undefined});
   res.setHeader('Content-Type','application/json');
   const body=text?JSON.parse(text):null;
   res.end(JSON.stringify(req.method==='GET'?{engine:null,status}:req.method==='PUT'?{status,files:{[body.locale]:{entries:body.entries}}}:{ok:true}));
  });
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
 const origin=`http://127.0.0.1:${http.address().port}`;
 const platform=new Platform({origin,configDirectory:join(dir,'.config','1gp-studio')});
 await mkdir(platform.directory,{recursive:true,mode:0o700});
 await writeFile(platform.file,JSON.stringify({token:'b'.repeat(64)}),{mode:0o600});
 const client=new Client({name:'1gp-language-test',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,ONEGP_PLATFORM_URL:origin,HOME:dir,USERPROFILE:dir},stderr:'pipe'}));
 t.after(()=>client.close());
 assert.equal(client.getServerVersion().version,packageInfo.version);
 const check=JSON.parse((await client.callTool({name:'check_game_languages',arguments:{project_directory:dir}})).content[0].text);
 assert.deepEqual(check.languages,['ru']);
 assert.deepEqual(check.siteLanguages,targets);
 assert.deepEqual(check.supportedGameLanguages,compatible);
 assert.ok(check.nextSteps.some(step=>step.includes('原始语言不在这五种中时保留原文')));

 const translations=compatible.filter(locale=>locale!=='ru').map(locale=>({locale,path:`locales/${locale}.json`}));
 for(const translation of translations)await writeFile(join(dir,translation.path),JSON.stringify({start:`Start ${translation.locale}`}));
 const all=JSON.parse((await client.callTool({name:'check_game_languages',arguments:{project_directory:dir}})).content[0].text);
 assert.deepEqual([...all.languages].sort(),[...compatible].sort(),'language detection must not lose files outside the website targets');
 const uploaded=await client.callTool({name:'upload_game_text',arguments:{project_directory:dir,gameSlug:'my-game',original:{locale:'ru',path:'locales/ru.json'},translations}});
 assert.equal(uploaded.isError,false);
 const data=JSON.parse(uploaded.content[0].text);
 assert.deepEqual(data.uploaded,['ru',...translations.map(item=>item.locale)]);
 assert.deepEqual(data.status.map(item=>item.locale),compatible,'upload status preserves all compatible game languages');
 assert.deepEqual(calls.filter(call=>call.method==='PUT').map(call=>call.body.locale),data.uploaded);
 const read=await client.callTool({name:'get_game_text_status',arguments:{gameSlug:'my-game'}});
 assert.equal(read.isError,false);
 assert.deepEqual(JSON.parse(read.content[0].text).status.map(item=>item.locale),compatible);

 for(const metadata of [
  {titles:{fr:'Titre français'},descriptions:{ru:'Описание игры'},languages:compatible},
  {titles:Object.fromEntries(targets.map(locale=>[locale,`Name ${locale}`]))},
  {descriptions:{en:'e'.repeat(2000),ja:'j'.repeat(4000),fr:'f'.repeat(4000)}},
 ]){
  const result=await client.callTool({name:'set_game_details',arguments:{gameSlug:'my-game',...metadata}});
  assert.equal(result.isError,false,'selected names must not require every compatible language');
  assert.deepEqual(calls.at(-1),{method:'PATCH',path:'/api/developer/language-files/my-game',body:metadata});
 }
 const before=calls.length;
 const invalid=await client.callTool({name:'set_game_details',arguments:{gameSlug:'my-game',titles:{it:'Unsupported'}}});
 assert.equal(invalid.isError,true);assert.equal(calls.length,before,'unknown locale keys are still rejected before sending');
 const tooLong=await client.callTool({name:'set_game_details',arguments:{gameSlug:'my-game',descriptions:{en:'e'.repeat(2001)}}});
 assert.equal(tooLong.isError,true);assert.equal(calls.length,before,'English must fit the author English field before sending');
 const prompt=await client.getPrompt({name:'make_game_multilingual'});
 assert.ok(prompt.messages[0].content.text.includes(targets.join('、')));
 assert.doesNotMatch(prompt.messages[0].content.text,/(?:其余|其他)\s*9\s*种/);
});
test('game text upload sends the original first, then translations as the creator\'s AI, and stays inside the project',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'zh.json'),'{"start":"开始"}');await writeFile(join(dir,'ja.json'),'{"start":"スタート"}');
 const calls=[];const platform={request:async(path,options={})=>{calls.push([path,options.method??'GET',options.body]);return options.method?{status:[],files:{[options.body.locale]:{entries:options.body.entries}}}:{engine:null,status:[]};}};
 const done=await uploadGameText(platform,dir,'my-game',{locale:'zh',path:'zh.json'},[{locale:'ja',path:'ja.json'}]);
 assert.deepEqual(done.uploaded,['zh','ja']);
 assert.deepEqual(calls.slice(0,2).map(([path,method,body])=>[path,method,body.kind,body.by]),[['/api/developer/language-files/my-game','PUT','original',undefined],['/api/developer/language-files/my-game','PUT','translation','ai_creator']]);
 const outside=await uploadGameText(platform,dir,'my-game',{locale:'zh',path:'../secret.json'});
 assert.match(outside.error,/项目目录/);
});
test('game details send names and descriptions per language in one request',async()=>{

 const calls=[];await setGameDetails({request:async(path,options)=>{calls.push([path,options]);return {ok:true};}},'my-game',{titles:{ja:'猫'},descriptions:{ja:'釣りをする猫'}});
 assert.deepEqual(calls,[['/api/developer/language-files/my-game',{method:'PATCH',body:{titles:{ja:'猫'},descriptions:{ja:'釣りをする猫'}}}]]);
});
test('maker details save only the given fields, alone or after names',async()=>{

 const calls=[];const platform={request:async(path,options)=>{calls.push([path,options]);return {ok:true};}};
 assert.deepEqual(await setGameDetails(platform,'my-game',{maker:{tools:['Claude Code'],orientation:'portrait'}}),{ok:true,maker:{saved:true}});
 assert.deepEqual(calls,[['/api/games/my-game/details',{method:'POST',body:{makerChanges:{tools:['Claude Code'],orientation:'portrait'}}}]]);
 calls.length=0;
 await setGameDetails(platform,'my-game',{titles:{ja:'猫'},maker:{session:'long'}});
 assert.deepEqual(calls.map(([path])=>path),['/api/developer/language-files/my-game','/api/games/my-game/details']);
 const failed=await setGameDetails({request:async path=>path.includes('details')?{error:'只能修改自己的游戏信息。'}:{ok:true}},'my-game',{titles:{ja:'猫'},maker:{session:'long'}});
 assert.deepEqual(failed.maker,{saved:false,error:'只能修改自己的游戏信息。'});
 const stopped=[];assert.equal((await setGameDetails({request:async path=>{stopped.push(path);return {error:'bad'};}},'my-game',{titles:{ja:''},maker:{session:'long'}})).error,'bad');
 assert.equal(stopped.length,1,'a failed name change does not go on to the maker details');
});

test('genre and tags without fillMissing replace the labels; the one not given keeps its current value',async()=>{
 const calls=[];const platform={request:async(path,options)=>{calls.push([path,options]);return path.includes('game-materials')?{game:{slug:'my-game'},original:{},languages:[],covers:{},labels:{genre:'puzzle',tags:['像素','解谜']}}:{ok:true};}};
 const both=await setGameDetails(platform,'my-game',{genre:'action',tags:['动作']});
 assert.deepEqual(both,{ok:true,labels:{saved:true,genre:'action',tags:['动作']}});
 assert.deepEqual(calls,[['/api/games/my-game/details',{method:'POST',body:{labels:{genre:'action',tags:['动作']}}}]],'both given: no read first');
 calls.length=0;
 const tagsOnly=await setGameDetails(platform,'my-game',{tags:['像素','单手'],maker:{session:'short'}});
 assert.deepEqual(calls.at(-1),['/api/games/my-game/details',{method:'POST',body:{makerChanges:{session:'short'},labels:{genre:'puzzle',tags:['像素','单手']}}}]);
 assert.deepEqual(tagsOnly.labels,{saved:true,genre:'puzzle',tags:['像素','单手']});
 const unread=await setGameDetails({request:async path=>path.includes('game-materials')?{error:'读不到'}:{ok:true}},'my-game',{genre:'idle'});
 assert.deepEqual(unread.labels,{saved:false,error:'读不到'});
});
