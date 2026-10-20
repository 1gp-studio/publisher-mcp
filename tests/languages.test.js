import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGameLanguages,uploadGameText } from '../src/languages.js';
test('language check reads language files and ?lang= handling without running code',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'langs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'locales'));await writeFile(join(dir,'locales/zh-CN.json'),'{"start":"开始"}');await writeFile(join(dir,'locales/en.json'),'{"start":"Start"}');
 await writeFile(join(dir,'game.js'),"const lang=navigator.language;button.textContent=t('start');");
 const found=await checkGameLanguages(dir);
 assert.equal(found.multilingual,true);assert.deepEqual(found.languages.sort(),['en','zh']);
 assert.equal(found.signals.readsLangParam,false);assert.equal(found.signals.readsBrowserLanguage,true);
 assert.match(found.nextSteps[0],/\?lang=/);
 const plain=await mkdtemp(join(tmpdir(),'plain-'));t.after(()=>rm(plain,{recursive:true,force:true}));
 await writeFile(join(plain,'index.html'),'<button>开始游戏</button>');
 const none=await checkGameLanguages(plain);assert.equal(none.multilingual,false);assert.match(none.nextSteps[0],/要不要做成多语言/);
});
test('game text upload sends the original first, then translations as the creator\'s AI, and stays inside the project',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'zh.json'),'{"start":"开始"}');await writeFile(join(dir,'ja.json'),'{"start":"スタート"}');
 const calls=[];const platform={request:async(path,options={})=>{calls.push([path,options.method??'GET',options.body]);return options.method?{}:{engine:null,status:[]};}};
 const done=await uploadGameText(platform,dir,'my-game',{locale:'zh',path:'zh.json'},[{locale:'ja',path:'ja.json'}]);
 assert.deepEqual(done.uploaded,['zh','ja']);
 assert.deepEqual(calls.slice(0,2).map(([path,method,body])=>[path,method,body.kind,body.by]),[['/api/developer/language-files/my-game','PUT','original',undefined],['/api/developer/language-files/my-game','PUT','translation','ai_creator']]);
 const outside=await uploadGameText(platform,dir,'my-game',{locale:'zh',path:'../secret.json'});
 assert.match(outside.error,/项目目录/);
});
