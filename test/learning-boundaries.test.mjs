import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig,loadCatalog } from '../src/config.mjs';
import { learnScope } from '../src/learn.mjs';
import { reviewProject,renderReport,diffFromGit } from '../src/review.mjs';
import { writeJson } from '../src/util.mjs';

test('a large modern project cannot impose its inferred style on a smaller legacy project in the same scope',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-mixed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['large','small'])fs.mkdirSync(path.join(root,name));
  fs.writeFileSync(path.join(root,'large','index.js'),Array.from({length:200},(_,i)=>`const value${i} = ${i};`).join('\n'));
  fs.writeFileSync(path.join(root,'small','index.js'),Array.from({length:10},(_,i)=>`var value${i} = ${i};`).join('\n'));
  writeJson(path.join(root,'config.json'),{schemaVersion:1,catalog:'catalog.json',bestPractices:false,scopes:[{id:'team'}],projects:[{id:'large',scope:'team',root:'large'},{id:'small',scope:'team',root:'small'}]});
  writeJson(path.join(root,'catalog.json'),{schemaVersion:1,rules:[]});
  const context=loadConfig(path.join(root,'config.json')),report=learnScope(context,'team');
  assert.equal(report.discovery.aggregate.declarations.const,200);
  assert.equal(report.discovery.aggregate.declarations.var,10);
  assert.equal(report.discovery.withheldCandidates.length,1);
  assert.equal(report.discovery.withheldCandidates[0].check.kind,'no-var');
  assert.equal(report.discovery.withheldCandidates[0].contradictions[0].project,'small');
  assert.equal(loadCatalog(context).rules.some(r=>r.check.kind==='no-var'),false);
});

test('Git diff collection disables repository clean filters without changing their configuration',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-filter-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',['-c','user.name=SelfReview Test','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init']);fs.writeFileSync(path.join(root,'source.js'),'const value = 1;\n');git(['add','source.js']);git(['commit','-m','fixture']);
  fs.writeFileSync(path.join(root,'.gitattributes'),'*.js filter=probe\n');git(['add','.gitattributes']);git(['commit','-m','attributes']);
  fs.writeFileSync(path.join(root,'filter.cjs'),"require('node:fs').writeFileSync('FILTER_EXECUTED', 'unexpected');");
  const command=`"${process.execPath.replaceAll('\\','/')}" filter.cjs`;
  git(['config','filter.probe.clean',command]);git(['config','filter.probe.required','true']);
  fs.writeFileSync(path.join(root,'source.js'),'const value = 2;\n');
  const result=diffFromGit(root,'HEAD');assert.match(result.diffText,/const value = 2/);
  assert.equal(fs.existsSync(path.join(root,'FILTER_EXECUTED')),false);
  assert.equal(git(['config','filter.probe.clean']).trim(),command);assert.equal(git(['config','filter.probe.required']).trim(),'true');
});

test('text review groups repeated advice while JSON retains every occurrence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-advice-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'code'));fs.writeFileSync(path.join(root,'code','index.js'),Array.from({length:20},(_,i)=>`var value${i} = ${i};`).join('\n'));
  writeJson(path.join(root,'config.json'),{schemaVersion:1,catalog:'catalog.json',scopes:[{id:'a'}],projects:[{id:'a',scope:'a',root:'code'}]});
  writeJson(path.join(root,'catalog.json'),{schemaVersion:1,rules:[]});
  const context=loadConfig(path.join(root,'config.json')),report=reviewProject(context,loadCatalog(context),'a');
  assert.equal(report.findings.filter(f=>f.ruleId==='bp.no-var').length,20);
  const text=renderReport(report);assert.match(text,/20 occurrence/);assert.match(text,/17 additional occurrence/);
  assert.equal((text.match(/Use let or const/g)??[]).length,3);assert.equal(report.exitCode,0);
});

test('UTF-8 BOM and CRLF source matches its supplied postimage without rewriting the file',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-bom-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'code'));const source='\ufeffconst value = 2;\r\n';fs.writeFileSync(path.join(root,'code','index.ts'),source);
  writeJson(path.join(root,'config.json'),{schemaVersion:1,catalog:'catalog.json',scopes:[{id:'a'}],projects:[{id:'a',scope:'a',root:'code'}]});
  writeJson(path.join(root,'catalog.json'),{schemaVersion:1,rules:[]});
  const context=loadConfig(path.join(root,'config.json'));
  const report=reviewProject(context,loadCatalog(context),'a',{diffText:'--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-\ufeffconst value = 1;\n+\ufeffconst value = 2;\n'});
  assert.equal(report.errors.length,0);assert.equal(report.exitCode,0);assert.equal(fs.readFileSync(path.join(root,'code','index.ts'),'utf8'),source);
});
