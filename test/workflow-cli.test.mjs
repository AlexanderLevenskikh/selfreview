import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const executable=fileURLToPath(new URL('../bin/selfreview.mjs',import.meta.url));
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview workflow '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'app');fs.mkdirSync(path.join(project,'src'),{recursive:true});
  fs.writeFileSync(path.join(project,'src','main.js'),'var count = 1;\n');
  const config=path.join(project,'selfreview.config.json');
  const invoke=(args,expected=0)=>{
    const result=spawnSync(process.execPath,[executable,...args,'--config',config],{cwd:root,encoding:'utf8',timeout:20000});
    assert.ifError(result.error);assert.equal(result.status,expected,`${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return {...result,json:()=>JSON.parse(result.stdout)};
  };
  invoke(['init','--scope','team','--project',project]);
  const catalog=path.join(project,'.selfreview','catalog.json');
  return {root,project,config,catalog,invoke};
}

test('CLI imports repeated evidence, previews without writing, records decisions and refreshes known sources',t=>{
  const f=fixture(t),doc=path.join(f.root,'agreements.md'),mr=path.join(f.root,'review.json');
  fs.writeFileSync(doc,'Do not use var.\n');
  fs.writeFileSync(mr,JSON.stringify({comments:[{id:1,body:'Do not use var.',path:'src/main.js',line:1},{id:2,body:'Do not use var.',path:'src/main.js',line:2}]}));
  f.invoke(['learn','--scope','team','--no-code','--docs',doc,'--mr',mr]);
  const rules=f.invoke(['rules','list','--json']).json();
  const noVar=rules.filter(rule=>rule.check.kind==='no-var');assert.equal(noVar.length,1);
  const before=fs.readFileSync(f.catalog);
  const preview=f.invoke(['rules','preview',noVar[0].id,'--project','app','--file','src/main.js']).json();
  assert.equal(preview.readOnly,true);assert.equal(preview.rule.status,'candidate');assert.ok(preview.reports.some(report=>report.findings.some(finding=>finding.ruleId===noVar[0].id)));
  assert.deepEqual(fs.readFileSync(f.catalog),before);
  f.invoke(['rules','approve',noVar[0].id,'--by','Reviewer','--reason','Confirmed synthetic convention']);
  f.invoke(['rules','reject',noVar[0].id,'--by','Reviewer','--reason','Exercise recorded reversal']);
  f.invoke(['rules','approve',noVar[0].id,'--by','Reviewer','--reason','Explicitly restored convention']);
  const history=f.invoke(['rules','history',noVar[0].id]).json();
  assert.ok(JSON.stringify(history).includes('Exercise recorded reversal'));
  fs.appendFileSync(doc,'\n# Background\n\nGeneral project information.\n');
  const changed=f.invoke(['sources','status','--scope','team']).json();assert.ok(changed.sources.some(source=>source.path===doc&&source.state==='changed'));
  f.invoke(['sources','refresh','--scope','team']);
  const refreshed=f.invoke(['rules','list','--json']).json().filter(rule=>rule.check.kind==='no-var');
  assert.equal(refreshed.length,1);assert.equal(refreshed[0].id,noVar[0].id);assert.equal(refreshed[0].status,'approved');
  fs.unlinkSync(doc);
  const missing=f.invoke(['sources','refresh','--scope','team'],2).json();assert.equal(missing.exitCode,2);
  assert.equal(f.invoke(['rules','show',noVar[0].id]).json().status,'approved');
});

test('CLI task context round-trips and its exact command reviews only selected files',t=>{
  const f=fixture(t),doc=path.join(f.root,'agreements.md'),saved=path.join(f.root,'task context.json');
  fs.writeFileSync(doc,'Do not use var.\n');f.invoke(['learn','--scope','team','--no-code','--docs',doc]);
  const rule=f.invoke(['rules','list','--json']).json().find(rule=>rule.check.kind==='no-var');
  f.invoke(['rules','approve',rule.id,'--by','Reviewer','--reason','Synthetic test']);
  f.invoke(['context','--project','app','--file','src/main.js','--out',saved]);
  assert.equal(f.invoke(['context','check','--input',saved]).json().status,'CONTEXT_CURRENT');
  const pack=JSON.parse(fs.readFileSync(saved,'utf8'));
  const reviewed=spawnSync(pack.commands.review.executable,pack.commands.review.args,{cwd:pack.commands.review.cwd,encoding:'utf8',timeout:20000});
  assert.equal(reviewed.status,1,reviewed.stderr);assert.deepEqual(JSON.parse(reviewed.stdout).sources.map(source=>source.path),['src/main.js']);
  fs.writeFileSync(path.join(f.project,'src','main.js'),'const count = 1;\n');
  assert.equal(f.invoke(['context','check','--input',saved],2).json().status,'STALE_CONTEXT');
  assert.equal(f.invoke(['review','--project','app','--file','src/main.js','--format','json']).json().status,'CHECKS_PASSED');
  f.invoke(['context','--project','app','--file','src/new.js','--out',saved]);
  assert.equal(JSON.parse(fs.readFileSync(saved,'utf8')).files[0].state,'planned');
});

test('CLI rejects unsupported mode combinations instead of ignoring their intent',t=>{
  const f=fixture(t);
  assert.match(f.invoke(['review','--project','app','--new-only'],2).stderr,/requires --base or --staged/);
  assert.match(f.invoke(['review','--project','app','--merge-base'],2).stderr,/requires --base/);
  assert.match(f.invoke(['context','--project','app','--base','HEAD'],2).stderr,/prepares working-tree/);
  assert.match(f.invoke(['context','check'],2).stderr,/requires --input/);
  assert.match(f.invoke(['context','check','--input','ignored.json','--project','wrong'],2).stderr,/saved selection/);
  assert.match(f.invoke(['context','--project','app','--merge-base'],2).stderr,/prepares working-tree/);
  assert.match(f.invoke(['sources','refresh'],2).stderr,/requires --scope/);
});

test('CLI staged review analyzes the index even when the working file is clean',t=>{
  const f=fixture(t),doc=path.join(f.root,'agreements.md');
  fs.writeFileSync(doc,'Do not use var.\n');f.invoke(['learn','--scope','team','--no-code','--docs',doc]);
  const rule=f.invoke(['rules','list','--json']).json().find(rule=>rule.check.kind==='no-var');
  f.invoke(['rules','approve',rule.id,'--by','Reviewer','--reason','Synthetic index test']);
  const nullDevice=process.platform==='win32'?'NUL':'/dev/null';
  const git=args=>{
    const result=spawnSync('git',['-c',`core.hooksPath=${nullDevice}`,'-c','commit.gpgSign=false','-c','user.name=SelfReview Test','-c','user.email=selfreview@example.invalid',...args],{
      cwd:f.project,encoding:'utf8',timeout:20000,env:{...process.env,GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  };
  fs.writeFileSync(path.join(f.project,'src','main.js'),'const count = 1;\n');
  git(['init','--quiet']);git(['add','--all']);git(['commit','--quiet','-m','Synthetic baseline']);
  fs.writeFileSync(path.join(f.project,'src','main.js'),'var count = 2;\n');git(['add','src/main.js']);
  fs.writeFileSync(path.join(f.project,'src','main.js'),'const count = 3;\n');
  const staged=f.invoke(['review','--project','app','--staged','--format','json'],1).json();
  assert.equal(staged.git.target,'index');assert.ok(staged.findings.some(finding=>finding.ruleId===rule.id));
  const current=f.invoke(['review','--project','app','--file','src/main.js','--format','json']).json();assert.equal(current.status,'CHECKS_PASSED');
  const agentFile=path.join(f.root,'staged-pack.json');
  f.invoke(['agent-pack','--project','app','--staged','--out',agentFile],1);
  const pack=JSON.parse(fs.readFileSync(agentFile,'utf8'));assert.equal(pack.reportBinding.matchesContext,false);assert.deepEqual(pack.reportBinding.mismatchedFiles,['src/main.js']);
  assert.equal(f.invoke(['context','check','--input',agentFile]).json().reportBinding.reportFreshness,'CURRENT_INDEX_SNAPSHOT');
  fs.writeFileSync(path.join(f.project,'src','main.js'),'var count = 4;\n');git(['add','src/main.js']);
  fs.writeFileSync(path.join(f.project,'src','main.js'),'const count = 3;\n');
  const drift=f.invoke(['context','check','--input',agentFile],2).json();
  assert.equal(drift.status,'STALE_CONTEXT');assert.ok(drift.changes.some(change=>change.reason==='REPORT_GIT_SNAPSHOT_CHANGED'));
});
