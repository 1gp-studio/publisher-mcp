import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTexts, displayWidth, validateGameText } from '../src/text-check.js';
test('translations keep keys, placeholders, line breaks, separators and length limits',()=>{
 const original={start:'开始',score:'得分 {0}',intro:'第一行\n第二行',list:'a|b|c'};
 const { errors, warnings }=checkTexts(original,{en:{start:'Start the whole game right now please',score:'Score',intro:'One line',list:'a|b',extra:'x'}},{separators:['|'],limits:{start:12}});
 const issues=errors.map(item=>`${item.key}:${item.issue}`).sort();
 assert.deepEqual(issues,['intro:line-breaks','list:separator','score:placeholders','start:too-long']);
 assert.ok(warnings.some(item=>item.key==='extra'));
 assert.equal(displayWidth('开始'),4);assert.equal(displayWidth('Go'),2);
});
test('validation reads a limits file next to the original and the fonts the game ships',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'check-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'locales'));
 await writeFile(join(dir,'locales/zh.json'),'{"start":"开始"}');await writeFile(join(dir,'locales/zh.limits.json'),'{"start":6}');
 await writeFile(join(dir,'locales/ko.json'),'{"start":"시작하기 버튼"}');
 const font='C:/Windows/Fonts/arial.ttf';
 if(existsSync(font))await copyFile(font,join(dir,'game-font.ttf'));
 const result=await validateGameText(dir,{locale:'zh',path:'locales/zh.json'},[{locale:'ko',path:'locales/ko.json'}]);
 assert.equal(result.ok,false);assert.equal(result.errors[0].issue,'too-long');
 if(existsSync(font)){assert.equal(result.fonts.gaps[0].locale,'ko');assert.match(result.fonts.gaps[0].advice,/Noto Sans KR/);}
});
