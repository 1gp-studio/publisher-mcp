import { readFile,readdir,lstat,realpath } from 'node:fs/promises';
import { resolve,isAbsolute,join,relative,sep,basename } from 'node:path';

// In-game text in every site language (platform docs/todo/game-translation.md, layer 1).
// The convention: player-facing text by key (t('start')), one file in the game's own language,
// the platform keeps the translations and serves /i18n/<game>/<lang>.json; the game reads ?lang=
// first (AIMadeGames.lang() / AIMadeGames.i18n() in the SDK).
export const siteLanguages=['zh','zh-Hant','en','es','pt-BR','ja','ko','de','fr','ru'];
const skip=new Set(['node_modules','.git','.1gp','.vercel','.next','dist','build','out','coverage','.godot','.import']);
const codeFile=/\.(?:html?|m?js|jsx|ts|tsx|vue|svelte|gd)$/i;
const languageDir=/(?:^|[\\/])(?:i18n|locales?|lang|langs|languages|translations|strings)(?:[\\/]|$)/i;
const fileLocale=name=>{
  const stem=basename(name,'.json').replace(/_/g,'-').toLowerCase();
  if(/^zh-(hant|tw|hk|mo)$/.test(stem))return 'zh-Hant';
  if(/^zh(-hans|-cn|-sg)?$/.test(stem))return 'zh';
  if(/^pt(-br)?$/.test(stem))return 'pt-BR';
  const base=stem.split('-')[0];
  return siteLanguages.includes(base)?base:null;
};
// Inside the project, a regular file, not a symlink: data only.
async function projectFile(directory,path,max=400000){
  const full=resolve(directory,path);
  if(relative(directory,full).startsWith('..')||isAbsolute(relative(directory,full)))throw new Error(`文件必须在项目目录里：${path}`);
  const stat=await lstat(full);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw new Error(`无法读取 ${path}（不是普通文件或超过 ${Math.round(max/1000)} KB）`);
  return readFile(full,'utf8');
}
async function* walk(directory,base=directory,depth=0){
  if(depth>8)return;
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
    if(entry.isSymbolicLink())continue;
    const full=join(directory,entry.name);
    if(entry.isDirectory()){if(!skip.has(entry.name)&&!entry.name.startsWith('.'))yield* walk(full,base,depth+1);}
    else if(entry.isFile())yield relative(base,full).split(sep).join('/');
  }
}
const flatStrings=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).length>0&&Object.values(value).every(item=>typeof item==='string');

// What the project already does about languages, read without running anything.
export async function checkGameLanguages(projectDirectory){
  if(!isAbsolute(projectDirectory))return {error:'请提供当前游戏项目的绝对路径。'};
  let directory;try{directory=await realpath(resolve(projectDirectory));}catch{return {error:'无法读取项目目录。'};}
  const files=[],signals={readsLangParam:false,readsBrowserLanguage:false,usesSdkLang:false,usesSdkI18n:false,i18nLibrary:false,keyCalls:0,hanTextLines:0};
  let scanned=0;
  for await(const path of walk(directory)){
    if(scanned>3000)break;
    if(path.endsWith('.json')&&(languageDir.test(path)||fileLocale(path))&&fileLocale(path)){
      try{const data=JSON.parse(await projectFile(directory,path));if(flatStrings(data))files.push({path,locale:fileLocale(path),keys:Object.keys(data).length});}catch{}
      continue;
    }
    if(!codeFile.test(path))continue;
    scanned++;
    let text;try{text=await projectFile(directory,path,2000000);}catch{continue;}
    if(/[?&]lang=|searchParams\.get\(\s*['"]lang['"]\)|get\(\s*['"]lang['"]\s*\)/.test(text))signals.readsLangParam=true;
    if(/navigator\.languages?\b|OS\.get_locale\(|TranslationServer/.test(text))signals.readsBrowserLanguage=true;
    if(/AIMadeGames\.lang\(/.test(text)){signals.usesSdkLang=true;signals.readsLangParam=true;}
    if(/AIMadeGames\.i18n\(/.test(text)){signals.usesSdkI18n=true;signals.readsLangParam=true;}
    if(/\bi18next\b|vue-i18n|react-intl|@formatjs|\bpolyglot\b/i.test(text))signals.i18nLibrary=true;
    signals.keyCalls+=(text.match(/\bt\(\s*['"][\w.:-]+['"]/g)??[]).length;
    signals.hanTextLines+=text.split('\n').filter(line=>/['"`>][^'"`<]*[一-鿿]/.test(line)).length;
  }
  const languages=[...new Set(files.map(file=>file.locale))];
  const multilingual=languages.length>1||signals.usesSdkI18n||signals.i18nLibrary;
  const nextSteps=[];
  if(signals.usesSdkI18n)nextSteps.push('已接平台多语言：上传原始语言文件和各语言翻译（upload_game_text），再用 get_game_text_status 核对。');
  else if(multilingual){
    if(!signals.readsLangParam)nextSteps.push('游戏已有多语言，但打开时没读 ?lang=：改成先读 ?lang=（或 AIMadeGames.lang()），再看浏览器语言。');
    nextSteps.push(`发布后用 set_game_details 把支持的语言（${languages.join(', ')||'检查代码确认'}）告诉平台；要补齐其他语言，可以改用平台多语言（键名 + 原始语言文件 + AIMadeGames.i18n），再 upload_game_text。`);
  }else nextSteps.push('还没做多语言。先问用户「要不要做成多语言」；同意后按 convention 改造：玩家看到的文字换成键名，写一份原始语言 JSON，接 AIMadeGames.i18n；用你自己的能力把这份文件翻成其他 9 种语言，发布后 upload_game_text 上传。用户不同意就照原样发布。');
  nextSteps.push('发布后用 set_game_details 上传各语言游戏名（短、像游戏名，不逐字直译；专有名词可保留）。');
  return {multilingual,languages,languageFiles:files.slice(0,40),signals,scannedFiles:scanned,siteLanguages,nextSteps,convention};
}
export const convention=[
  '玩家看到的文字都用键名显示（t(\'start\')）；游戏只带一份原始语言的 JSON（{"键名": "文字"}，可用 {0}、{name} 占位）。',
  '加载平台 SDK：<script src="https://www.ai-made.games/sdk/v1.js"></script>，用 AIMadeGames.i18n({ game: \'<游戏 slug>\', original, originalLang: \'zh\' }).then(t => …) 取文字；请求失败或缺条目时用 original。',
  '默认语言：先读 ?lang=（zh、zh-Hant、en、es、pt-BR、ja、ko、de、fr、ru），没有再看浏览器语言；SDK 的 AIMadeGames.lang() 已按这个顺序。游戏里可以有语言切换，但打开时必须听 ?lang=。',
  '字体：中日韩俄要有能显示这些字的字体，别只用拉丁像素字体；按钮和固定宽度的地方给变长的文字留余量（德语、俄语常比中文长一倍）。',
  '翻译：按游戏的语气翻，按钮短而清楚，占位符原样保留，专有名词不硬译。每种语言一个 JSON，键名和原始语言文件完全一致。',
].join('\n');

async function readEntries(directory,path){
  const data=JSON.parse(await projectFile(directory,path));
  if(!flatStrings(data))throw new Error(`${path} 要是 {"键名": "文字"} 的 JSON 对象。`);
  return data;
}
// Upload the game's own file, then each translation (marked as made by the creator's AI).
export async function uploadGameText(platform,projectDirectory,gameSlug,original,translations=[]){
  if(!isAbsolute(projectDirectory))return {error:'请提供当前游戏项目的绝对路径。'};
  let directory;try{directory=await realpath(resolve(projectDirectory));}catch{return {error:'无法读取项目目录。'};}
  const path=`/api/developer/language-files/${encodeURIComponent(gameSlug)}`,uploaded=[];
  try{
    if(original){
      const result=await platform.request(path,{method:'PUT',body:{locale:original.locale,kind:'original',entries:await readEntries(directory,original.path)}});
      if(result.error)return {...result,uploaded};
      uploaded.push(original.locale);
    }
    for(const item of translations){
      const result=await platform.request(path,{method:'PUT',body:{locale:item.locale,kind:'translation',by:'ai_creator',entries:await readEntries(directory,item.path)}});
      if(result.error)return {...result,uploaded,failed:item.locale};
      uploaded.push(item.locale);
    }
  }catch(error){return {error:error.message,uploaded};}
  return {ok:true,uploaded,...await gameTextStatus(platform,gameSlug)};
}
// Per language: up to date, missing keys, or made from an older original (only those need translating).
export async function gameTextStatus(platform,gameSlug){
  const data=await platform.request(`/api/developer/language-files/${encodeURIComponent(gameSlug)}`);
  if(data.error)return data;
  return {platformTranslation:data.engine??null,status:(data.status??[]).map(item=>({locale:item.locale,state:item.state,total:item.total,done:item.done,missing:item.missing,stale:item.stale,editedByCreator:item.edited}))};
}
export async function setGameDetails(platform,gameSlug,{titles,languages}){
  return platform.request(`/api/developer/language-files/${encodeURIComponent(gameSlug)}`,{method:'PATCH',body:{...(titles?{titles}:{}),...(languages?{languages}:{})}});
}
