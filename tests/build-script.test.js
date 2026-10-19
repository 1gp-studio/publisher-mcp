import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildScript } from '../src/build-script.js';

test('quoted names, executable paths, flags and nested lifecycle hooks are inspected',()=>{
  const commands=[
    'npm run compile','npm --silent run "compile"',"npm run 'compile'",'npm run co"mp"ile',
    '"npm" run "compile"','"C:\\Program Files\\nodejs\\npm.cmd" --silent run "compile"',
    'npm --loglevel silent run --if-present compile -- --mode production',
    'node prepare.cjs && npm run "compile"','npm run compile || npm run fallback',
    'pnpm -s "compile"','yarn --silent run "compile"','npm test',
  ];
  for(const command of commands) {
    const pkg={scripts:{build:command,compile:'node compile.cjs',fallback:'node fallback.cjs',test:'node test.cjs',precompile:'"vercel" --prod',pretest:'npx -y vercel deploy'}};
    assert.throws(()=>validateBuildScript(pkg,'build'),/不能调用 Vercel CLI/,command);
    delete pkg.scripts.precompile;delete pkg.scripts.pretest;
    assert.doesNotThrow(()=>validateBuildScript(pkg,'build'),command);
  }
  assert.throws(()=>validateBuildScript({scripts:{build:'npm run compile',compile:'npm run bundle',bundle:'node bundle.cjs',postbundle:'vc deploy'}},'build'),/不能调用 Vercel CLI/);
});

test('ambiguous shell and package-manager dispatch stop before any build',()=>{
  for(const command of [
    'npm run "$TASK"','npm run %TASK%','npm run !TASK!','npm run $(echo compile)','npm run `echo compile`',
    'npm run "compile','(npm run compile)','sh -c "npm run compile"','cmd /c "npm run compile"','env sh -c "npm run compile"','npx -c "npm run compile"',
    'npm --prefix ../other run compile','npm run compile --workspace client','pnpm --filter client compile',
    'npm --unknown-option compile run build','npm install','npm exec node build.cjs','npm -- run compile',
  ])assert.throws(()=>validateBuildScript({scripts:{build:command,compile:'node compile.cjs'}},'build'),/无法可靠检查/,command);
});

test('static local build commands and harmless quoted data remain usable',()=>{
  for(const command of ['vite build','node "scripts/build game.cjs"','node -e "console.log(\'ready; build\')"','npm run compile -- --label "two words"']) {
    assert.doesNotThrow(()=>validateBuildScript({scripts:{build:command,compile:'vite build'}},'build'),command);
  }
  assert.doesNotThrow(()=>validateBuildScript({scripts:{build:'node build.cjs',prebuild:'npm run prepare',prepare:'node prepare.cjs'}},'build'));
});
