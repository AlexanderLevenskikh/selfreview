import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadCatalog, mutateCatalog, resolveRules } from '../src/config.mjs';
import { extractDocument } from '../src/ingest.mjs';
import { approveRule, behaviorHash, logicalRuleKey, validateRule } from '../src/rules.mjs';
import { learnScope, refreshScope } from '../src/learn.mjs';
import { previewRule, sourceStatus, ruleHistory, recordRuleDecision, validateLifecycleMetadata } from '../src/lifecycle.mjs';
import { writeJson, sha256 } from '../src/util.mjs';

function fixture(t, projects=[{id:'app',scope:'a',files:{'src/one.ts':'var one = 1;\n','src/two.ts':'var two = 2;\n'}}]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-lifecycle-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const write=(name,text)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  for(const project of projects)for(const [name,text]of Object.entries(project.files))write(`projects/${project.id}/${name}`,text);
  const configFile=path.join(directory,'settings','selfreview.config.json');
  const scopes=[...new Set(projects.map(project=>project.scope))].map(id=>({id,extends:[],disabledRules:[]}));
  writeJson(configFile,{schemaVersion:1,catalog:'catalog.json',bestPractices:false,scopes,projects:projects.map(project=>({id:project.id,scope:project.scope,root:`../projects/${project.id}`}))});
  const context=loadConfig(configFile);writeJson(context.catalogPath,{schemaVersion:1,rules:[]});
  return {directory,context,write,catalog:()=>loadCatalog(context),learn:options=>learnScope(context,projects[0].scope,{code:false,...options})};
}
function decide(f,id,to='approved') {
  return mutateCatalog(f.context,catalog=>{
    const index=catalog.rules.findIndex(rule=>rule.id===id),before=structuredClone(catalog.rules[index]);
    const at='2026-11-09T12:00:00.000Z',by='Fixture reviewer',reason='Explicit test decision';
    const after=to==='approved'?approveRule(before,by,reason,at):{...before,status:'rejected',rejection:{by,reason,at}};
    if(to==='rejected')delete after.approval;
    catalog.rules[index]=after;recordRuleDecision(catalog,id,{from:before.status,to,by,reason,at,behaviorHash:behaviorHash(after),before});
    return structuredClone(after);
  },{allowStale:true});
}
const jsonRule=(overrides={})=>({title:'Application logging',description:'The application uses the team logger.',family:'no-console',mode:'enforce',severity:'error',check:{kind:'no-console',options:{allowMethods:['warn']}},applicability:{include:['src/**'],exclude:[]},...overrides});

test('repeated MR evidence produces one logical candidate and one approved policy',t=>{
  const f=fixture(t);
  const files=[1,2,3].map(index=>f.write(`reviews/${index}.json`,JSON.stringify({comments:[{id:index,body:'Do not use var.',path:`src/${index}.ts`,line:index,side:'new'}]})));
  const learned=f.learn({mrs:files});
  assert.equal(learned.added.length,1);
  let catalog=f.catalog();assert.equal(catalog.rules.length,1);
  assert.equal(catalog.rules[0].evidence.length,3);
  assert.equal(new Set(catalog.lifecycle.rules[0].evidence.map(item=>item.path)).size,3);
  const approved=decide(f,catalog.rules[0].id),snapshot=JSON.stringify(approved);
  const fourth=f.write('reviews/4.json',JSON.stringify({comments:[{id:4,body:'Do not use var.',path:'src/four.ts',line:4}]}));
  const again=f.learn({mrs:[fourth]});catalog=f.catalog();
  assert.deepEqual(again.added,[]);assert.equal(again.mergedEvidence[0].addedEvidence,1);
  assert.equal(JSON.stringify(catalog.rules[0]),snapshot);validateRule(catalog.rules[0]);
  assert.equal(catalog.lifecycle.rules[0].evidence.length,4);
  assert.equal(resolveRules(f.context.config,catalog,'a','src/one.ts').conflicts.length,0);
});

test('editorial source changes neither requeue nor amend an approved rule',t=>{
  const f=fixture(t),file=f.write('agreements.md','# Agreements\n\nDo not use var.\n');
  const first=f.learn({docs:[file]}),id=first.added[0],approved=decide(f,id),snapshot=JSON.stringify(approved);
  f.write('agreements.md','# Agreements\n\n\nDo not use var.\n\nA separate editorial note.\n');
  const refreshed=f.learn({docs:[file]}),catalog=f.catalog();
  assert.equal(catalog.rules.filter(rule=>rule.check.kind==='no-var').length,1);
  assert.ok(refreshed.unchanged.includes(id));assert.equal(refreshed.revisions.length,0);
  assert.equal(JSON.stringify(catalog.rules.find(rule=>rule.id===id)),snapshot);
  const history=ruleHistory(f.context,catalog,id);
  assert.equal(history.observation.evidence.length,2);assert.equal(history.approvalCurrent,true);
  assert.equal(history.sources[0].state,'current');assert.equal(history.sources[0].requiresReview,false);
});

test('rejected decisions remain rejected after source relocation and unrelated edits',t=>{
  const f=fixture(t),first=f.write('old.md','Do not use var.\n');
  const learned=f.learn({docs:[first]}),id=learned.added[0],rejected=decide(f,id,'rejected');
  const second=f.write('new.md','Do not use var.\n\nEditorial context.\n');
  const again=f.learn({docs:[second]});
  assert.ok(again.unchanged.includes(id));
  assert.deepEqual(f.catalog().rules.find(rule=>rule.id===id),rejected);
  assert.equal(f.catalog().rules.filter(rule=>rule.check.kind==='no-var').length,1);
});

test('complete equivalent definitions normalize set ordering but preserve all policy differences',()=>{
  const make=data=>extractDocument('```selfreview-rule\n'+JSON.stringify(data)+'\n```',{scope:'a',sourcePath:'rules.md'}).candidates[0];
  const base=make(jsonRule({check:{kind:'no-console',options:{allowMethods:['warn','error']}}}));
  const reordered=make(jsonRule({check:{kind:'no-console',options:{allowMethods:['error','warn']}}}));
  assert.equal(logicalRuleKey(base),logicalRuleKey(reordered));
  for(const change of [
    {mode:'advisory'}, {severity:'warning'}, {family:'project.console'},
    {description:'Only production code uses the team logger.'},
    {applicability:{include:['tests/**'],exclude:[]}},
    {check:{kind:'no-console',options:{allowMethods:[]}}},
    {overrides:['prior.console'],overrideReason:'An explicit reviewed exception'},
    {examples:[{code:'console.log(1)',filename:'example.ts',expect:'violation'}]},
  ])assert.notEqual(logicalRuleKey(base),logicalRuleKey(make(jsonRule(change))),JSON.stringify(change));
  assert.notEqual(logicalRuleKey(base),logicalRuleKey({...base,scope:'b'}));
});

test('different conditional/manual descriptions never merge by shared AST kind',t=>{
  const f=fixture(t),one=f.write('production.md','## Production code only\nDo not use console.\n'),two=f.write('tests.md','## tests/**\nDo not use console.\n');
  f.learn({docs:[one,two]});const rules=f.catalog().rules;
  assert.equal(rules.length,2);assert.ok(rules.every(rule=>rule.check.kind==='manual'));
  assert.notEqual(rules[0].id,rules[1].id);assert.ok(rules[0].description.includes('Production'));
  assert.ok(rules[1].description.includes('tests/**'));
});

test('semantic changes create linked candidates without silently replacing an approved version',t=>{
  const f=fixture(t),file=f.write('logging.json',JSON.stringify(jsonRule()));
  const original=f.learn({docs:[file]}).added[0],approved=decide(f,original);
  f.write('logging.json',JSON.stringify(jsonRule({check:{kind:'no-console',options:{allowMethods:['warn','error']}}})));
  const result=refreshScope(f.context,'a'),catalog=f.catalog();
  assert.equal(result.exitCode,0);assert.equal(result.added.length,1);
  const replacement=catalog.rules.find(rule=>rule.id===result.added[0]);
  assert.equal(replacement.status,'candidate');assert.equal(replacement.overrides,undefined);
  assert.deepEqual(catalog.rules.find(rule=>rule.id===original),approved);
  assert.ok(result.revisions.some(link=>link.previous===original&&link.candidate===replacement.id&&link.relation==='potential-revision'));
  assert.ok(result.warnings.some(warning=>warning.reason==='SOURCE_RULE_NOT_REOBSERVED'));
  const source=result.sources.find(source=>source.path===file);
  assert.equal(source.state,'current');assert.equal(source.requiresReview,true);assert.deepEqual(source.unobservedApprovedRuleIds,[original]);
});

test('a disappeared approved clause stays visible even without an equivalent replacement',t=>{
  const f=fixture(t),file=f.write('rules.md','Do not use var.\n');
  const id=f.learn({docs:[file]}).added[0],approved=decide(f,id);
  f.write('rules.md','Var is allowed in this legacy adapter.\n');
  const result=refreshScope(f.context,'a');
  assert.deepEqual(f.catalog().rules.find(rule=>rule.id===id),approved);
  assert.ok(result.warnings.some(w=>w.reason==='SOURCE_RULE_NOT_REOBSERVED'&&w.ruleIds.includes(id)));
  assert.ok(result.sources[0].unobservedApprovedRuleIds.includes(id));
  assert.equal(sourceStatus(f.context,f.catalog(),{scope:'a'}).status,'SOURCES_REQUIRE_ATTENTION');
});

test('legacy v1 catalogs retain IDs and byte-for-byte approval objects on reimport',t=>{
  const f=fixture(t),file=f.write('rules.md','Do not use var.\n');
  const imported=extractDocument('Do not use var.\n',{scope:'a',sourcePath:file}).candidates[0];
  const approved=approveRule({...imported,id:'old-v1-rule-id'},'Legacy reviewer','Confirmed before lifecycle metadata','2026-10-01T00:00:00.000Z');
  writeJson(f.context.catalogPath,{schemaVersion:1,rules:[approved]});
  const result=f.learn({docs:[file]}),catalog=f.catalog();
  assert.deepEqual(result.added,[]);assert.deepEqual(result.unchanged,[approved.id]);
  assert.deepEqual(catalog.rules,[approved]);validateRule(catalog.rules[0]);
  assert.equal(catalog.schemaVersion,1);assert.equal(catalog.lifecycle.rules[0].ruleId,approved.id);
});

test('an edited approved legacy ID cannot reuse observations of a different logical policy',t=>{
  const f=fixture(t),one=f.write('one.json',JSON.stringify(jsonRule())),two=f.write('two.json',JSON.stringify(jsonRule()));
  const id=f.learn({docs:[one,two]}).added[0];decide(f,id);
  const priorKey=f.catalog().lifecycle.rules.find(record=>record.ruleId===id).logicalKey;
  const edited=f.catalog();edited.rules.find(rule=>rule.id===id).check.options.allowMethods=['error'];
  writeJson(f.context.catalogPath,edited);
  assert.throws(()=>f.learn({docs:[one]}),/STALE_APPROVAL/);
  const staleStatus=sourceStatus(f.context,loadCatalog(f.context,{allowStale:true}));
  assert.ok(staleStatus.sources.every(source=>source.unobservedApprovedRuleIds.includes(id)));
  const explicitlyApproved=decide(f,id),snapshot=JSON.stringify(explicitlyApproved);
  f.write('one.json',JSON.stringify(jsonRule({check:{kind:'no-console',options:{allowMethods:['error']}}})));
  const imported=f.learn({docs:[one]}),catalog=f.catalog(),record=catalog.lifecycle.rules.find(item=>item.ruleId===id);
  assert.deepEqual(imported.added,[]);assert.ok(imported.warnings.some(warning=>warning.reason==='RULE_LOGICAL_IDENTITY_CHANGED'));
  assert.equal(JSON.stringify(catalog.rules.find(rule=>rule.id===id)),snapshot);
  assert.equal(record.previousDefinitions[0].logicalKey,priorKey);
  assert.equal(record.previousDefinitions[0].evidence.length,2);
  assert.equal(record.logicalKey,logicalRuleKey(explicitlyApproved));assert.equal(record.evidence.length,1);
  const sources=sourceStatus(f.context,catalog).sources;
  assert.equal(sources.find(source=>source.path===one).requiresReview,false);
  assert.equal(sources.find(source=>source.path===two).requiresReview,true);
  assert.ok(sources.find(source=>source.path===two).unobservedApprovedRuleIds.includes(id));
});

test('source status distinguishes current changed missing and unavailable without writes',t=>{
  const f=fixture(t),files=['current','changed','missing','unavailable'].map(name=>f.write(`${name}.md`,'Do not use var.\n'));
  f.learn({docs:files});const id=f.catalog().rules[0].id;decide(f,id);
  f.write('changed.md','No debugger.\n');fs.unlinkSync(files[2]);fs.unlinkSync(files[3]);fs.mkdirSync(files[3]);
  const catalog=f.catalog(),before=fs.readFileSync(f.context.catalogPath,'utf8'),mtime=fs.statSync(f.context.catalogPath).mtimeMs;
  const result=sourceStatus(f.context,catalog,{scope:'a'});
  assert.equal(result.readOnly,true);assert.deepEqual(result.sources.map(source=>source.state),['current','changed','missing','unavailable']);
  assert.equal(result.sources[1].currentSha256,sha256('No debugger.\n'));
  assert.equal(result.sources[1].observedSha256,sha256('Do not use var.\n'));
  assert.equal(result.sources[1].requiresReview,true);
  assert.equal(fs.readFileSync(f.context.catalogPath,'utf8'),before);assert.equal(fs.statSync(f.context.catalogPath).mtimeMs,mtime);
  assert.doesNotThrow(()=>validateRule(catalog.rules[0]));
  const refreshed=refreshScope(f.context,'a');assert.equal(refreshed.exitCode,2);
  assert.ok(refreshed.warnings.some(warning=>warning.reason==='SOURCE_NOT_READABLE'));
});

test('refresh preserves paired diff/comment provenance and refuses a missing partner',t=>{
  const f=fixture(t),diff=f.write('change.diff','--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-const one = 1;\n+var one = 1;\n');
  const comments=f.write('comments.json',JSON.stringify([{id:1,body:'Do not use var.',path:'src/one.ts',line:1,side:'new'}]));
  f.learn({diff,comments});
  f.write('comments.json',JSON.stringify([{id:1,body:'No debugger.',path:'src/one.ts',line:1,side:'new'}]));
  const refreshed=refreshScope(f.context,'a');assert.equal(refreshed.exitCode,0);
  const debuggerRule=f.catalog().rules.find(rule=>rule.check.kind==='no-debugger');
  assert.equal(debuggerRule.evidence[0].diffPath,diff);assert.equal(debuggerRule.evidence[0].diffSha256,sha256(fs.readFileSync(diff)));
  assert.equal(debuggerRule.evidence[0].contextState,'in-diff');
  fs.unlinkSync(diff);const before=JSON.stringify(f.catalog().rules);
  const failed=refreshScope(f.context,'a');assert.equal(failed.exitCode,2);
  assert.ok(failed.warnings.some(warning=>warning.reason==='PAIRED_SOURCE_REFRESH_UNAVAILABLE'));
  assert.equal(JSON.stringify(f.catalog().rules),before);
});

test('registered refresh does not discover new folder files or silently enable code mining',t=>{
  const f=fixture(t),first=f.write('agreements/first.md','No debugger.\n');
  f.learn({docs:[path.dirname(first)]});f.write('agreements/new.md','Do not use var.\n');
  const result=refreshScope(f.context,'a');
  assert.equal(result.exitCode,0);assert.ok(result.reports.every(report=>report.codeFilesAnalyzed===0));
  assert.equal(f.catalog().rules.length,1);assert.equal(f.catalog().rules[0].check.kind,'no-debugger');
});

test('proposal coverage keeps supported sparse and unobserved projects distinct',t=>{
  const source=count=>Array.from({length:count},(_,index)=>`const value${index} = ${index};`).join('\n');
  const f=fixture(t,[
    {id:'major',scope:'shared',files:{'src/a.ts':source(200)}},
    {id:'sparse',scope:'shared',files:{'src/b.ts':'var a=1;var b=2;var c=3;var d=4;'}},
    {id:'empty',scope:'shared',files:{'src/c.ts':'// no declaration observations\n'}},
  ]);
  const result=f.learn({code:true}),proposal=result.proposalCoverage.find(item=>item.check.kind==='no-var');
  assert.deepEqual(proposal.projects.map(project=>[project.project,project.status]),[['major','supported'],['sparse','insufficient'],['empty','unobserved']]);
  assert.equal(proposal.projects[2].ratio,null);assert.ok(f.catalog().rules.every(rule=>rule.status==='candidate'));
  assert.deepEqual(f.catalog().lifecycle.rules.find(rule=>rule.ruleId===proposal.ruleId).projectCoverage,proposal.projects);
});

test('adequate contradictory evidence withholds the common proposal with explicit project status',t=>{
  const f=fixture(t,[
    {id:'major',scope:'shared',files:{'a.js':Array.from({length:200},(_,i)=>`const v${i}=${i};`).join('\n')}},
    {id:'legacy',scope:'shared',files:{'b.js':Array.from({length:10},(_,i)=>`var v${i}=${i};`).join('\n')}},
  ]);
  const result=f.learn({code:true});
  assert.equal(f.catalog().rules.length,0);
  const held=result.discovery.withheldCandidates.find(item=>item.check.kind==='no-var');
  assert.ok(held.projectCoverage.some(row=>row.project==='legacy'&&row.status==='contradicted'));
});

test('changing discovery counts accumulates observations without recreating logical policy',t=>{
  const f=fixture(t,[{id:'app',scope:'a',files:{'a.js':Array.from({length:10},(_,i)=>`const x${i}=${i};`).join('\n')}}]);
  const first=f.learn({code:true}),id=first.added[0],approved=decide(f,id);
  f.write('projects/app/a.js',Array.from({length:20},(_,i)=>`const x${i}=${i};`).join('\n'));
  const again=f.learn({code:true});assert.deepEqual(again.added,[]);assert.ok(again.unchanged.includes(id));
  assert.deepEqual(f.catalog().rules.find(rule=>rule.id===id),approved);
  assert.notEqual(f.catalog().lifecycle.rules[0].lastObservation.observations.datasetSha256,approved.observations.datasetSha256);
});

test('preview uses selected applicable files and checked examples without storing an approval',t=>{
  const f=fixture(t),file=f.write('no-var.json',JSON.stringify({title:'No var',description:'Use block-scoped declarations.',check:{kind:'no-var',options:{}},applicability:{include:['src/one.ts'],exclude:[]},examples:[{filename:'example.ts',code:'const x=1;',expect:'valid'},{filename:'example.ts',code:'var x=1;',expect:'violation'}]}));
  const id=f.learn({docs:[file]}).added[0],before=fs.readFileSync(f.context.catalogPath,'utf8');
  const preview=previewRule(f.context,f.catalog(),id,{projectId:'app',files:['src/one.ts']});
  assert.equal(preview.readOnly,true);assert.equal(preview.decisionStored,false);assert.equal(preview.rule.status,'candidate');
  assert.equal(preview.summary.candidateFindings,1);assert.equal(preview.reports[0].coverage.selectedFiles,1);
  assert.deepEqual(preview.findings.map(finding=>finding.path),['src/one.ts']);assert.equal(preview.examples.status,'PASS');
  assert.equal(fs.readFileSync(f.context.catalogPath,'utf8'),before);assert.equal(f.catalog().rules[0].status,'candidate');
  const outside=previewRule(f.context,f.catalog(),id,{projectId:'app',files:['src/two.ts']});assert.equal(outside.findings.length,0);
  assert.throws(()=>previewRule(f.context,f.catalog(),id,{projectId:'app',files:['../outside.ts']}));
});

test('preview preserves real policy conflicts instead of auto-overriding an older rule',t=>{
  const f=fixture(t),file=f.write('logging.json',JSON.stringify(jsonRule()));
  const id=f.learn({docs:[file]}).added[0];decide(f,id);
  f.write('logging.json',JSON.stringify(jsonRule({severity:'warning'})));
  const next=f.learn({docs:[file]}).added[0],before=fs.readFileSync(f.context.catalogPath,'utf8');
  const preview=previewRule(f.context,f.catalog(),next,{projectId:'app'});
  assert.equal(preview.status,'PREVIEW_INCOMPLETE');assert.ok(preview.conflicts.length>0);
  assert.equal(fs.readFileSync(f.context.catalogPath,'utf8'),before);
});

test('decision history retains explicit transitions and does not invent a legacy timestamp',t=>{
  const f=fixture(t),file=f.write('rules.md','No debugger.');
  const candidate=extractDocument('No debugger.',{scope:'a',sourcePath:file}).candidates[0];
  const old=approveRule({...candidate,id:'legacy.rule'},'Earlier reviewer','Earlier approval');delete old.approval.at;
  writeJson(f.context.catalogPath,{schemaVersion:1,rules:[old]});
  decide(f,old.id,'rejected');
  const history=ruleHistory(f.context,f.catalog(),old.id);
  assert.equal(history.decisions.length,2);assert.equal(history.decisions[0].preexisting,true);
  assert.equal(Object.hasOwn(history.decisions[0],'at'),false);
  assert.deepEqual(history.decisions.map(item=>item.to),['approved','rejected']);
  assert.equal(history.rule.status,'rejected');
});

test('metadata references cannot cross scopes or invent a rule',t=>{
  const f=fixture(t),file=f.write('rules.md','No debugger.');f.learn({docs:[file]});
  const catalog=f.catalog();catalog.lifecycle.rules[0].sourceIds=['source-does-not-exist'];
  assert.throws(()=>validateLifecycleMetadata(catalog,f.context),/unknown or cross-scope source/);
  const another=f.catalog();another.lifecycle.revisions.push({previous:another.rules[0].id,candidate:'missing',sourceId:another.lifecycle.sources[0].id,reason:'SOURCE_RULE_CHANGED',relation:'potential-revision',at:new Date().toISOString()});
  assert.throws(()=>validateLifecycleMetadata(another,f.context),/Invalid lifecycle revision rule reference/);
});
