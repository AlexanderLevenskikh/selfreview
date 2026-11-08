import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskContext, checkTaskContext } from '../src/context.mjs';
import { evaluateRuleExamples } from '../src/examples.mjs';
import { createAgentPack } from '../src/export.mjs';
import { reviewProject } from '../src/review.mjs';
import { loadConfig, loadCatalog } from '../src/config.mjs';
import { approveRule } from '../src/rules.mjs';
import { digest, sha256, writeJson } from '../src/util.mjs';

function rule(id,kind='no-var',values={}) {
  return approveRule({id,family:kind,title:id,description:`Synthetic ${kind} agreement`,scope:'team',status:'candidate',severity:'error',mode:'enforce',
    check:{kind,options:{}},evidence:[{kind:'test',path:'synthetic-policy',sha256:digest(id)}],...values},'test reviewer','Synthetic policy');
}
function fixture(t,rules,changes={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'selfreview-context-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'test'));
  fs.writeFileSync(path.join(root,'src','main.js'),'const count = 1;\n');fs.writeFileSync(path.join(root,'test','main.js'),'console.warn("test");\n');
  const configPath=path.join(root,'selfreview.config.json'),catalogPath=path.join(root,'catalog.json');
  writeJson(configPath,{schemaVersion:1,catalog:'catalog.json',bestPractices:false,scopes:[{id:'base'},{id:'team',extends:['base']}],projects:[{id:'app',root:'.',scope:'team',exclude:['legacy/**']}],...changes});
  writeJson(catalogPath,{schemaVersion:1,rules});
  const context=loadConfig(configPath),catalog=loadCatalog(context);return {root,configPath,catalogPath,context,catalog};
}

test('context resolves inherited overrides per file and keeps candidates scoped',t=>{
  const parent=rule('base-console','no-console',{scope:'base'});
  const child=rule('test-console','no-console',{check:{kind:'no-console',options:{allowMethods:['warn']}},applicability:{include:['test/**']},overrides:[parent.id],overrideReason:'Tests permit warn'});
  const question={...rule('test-question','manual',{applicability:{include:['test/**']}}),status:'candidate'};delete question.approval;
  const f=fixture(t,[parent,child,question]);
  const pack=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js','test/main.js']});
  assert.equal(pack.status,'CONTEXT_READY');
  assert.deepEqual(pack.files.find(file=>file.path==='src/main.js').effectiveRuleIds,['base-console']);
  assert.deepEqual(pack.files.find(file=>file.path==='test/main.js').effectiveRuleIds,['test-console']);
  assert.deepEqual(pack.candidateQuestions[0].files,['test/main.js']);
  assert.ok(pack.suppressed.some(item=>item.path==='test/main.js'&&item.id==='base-console'));
  assert.ok(pack.commands.review.args.includes(f.configPath));
  assert.equal(pack.projectRoot,fs.realpathSync(f.root));
  const serialized=JSON.parse(JSON.stringify(pack));
  assert.equal(checkTaskContext(f.context,f.catalog,serialized).status,'CONTEXT_CURRENT');
});

test('context removes disabled requirements and binds manual questions to selected files',t=>{
  const f=fixture(t,[rule('disabled'),rule('ownership','manual')],{scopes:[{id:'team',disabledRules:[{id:'disabled',reason:'Explicit exception'}]}]});
  const pack=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  assert.ok(!pack.approvedRules.some(rule=>rule.id==='disabled'));
  assert.deepEqual(pack.manualChecklist[0].files,[{path:'src/main.js',startLine:1,endLine:2}]);
  assert.match(pack.manualChecklist[0].expectedAnswer,/uncertainty/);
});

test('planned source paths get effective rules and become stale when created',t=>{
  const f=fixture(t,[rule('no-var')]);
  const pack=createTaskContext(f.context,f.catalog,'app',{files:['src/new.js']});
  assert.equal(pack.files[0].state,'planned');assert.deepEqual(pack.files[0].effectiveRuleIds,['no-var']);
  assert.equal(checkTaskContext(f.context,f.catalog,pack).status,'CONTEXT_CURRENT');
  fs.writeFileSync(path.join(f.root,'src','new.js'),'const created = true;\n');
  const checked=checkTaskContext(f.context,f.catalog,pack);
  assert.equal(checked.status,'STALE_CONTEXT');assert.ok(checked.changes.some(change=>change.reason==='SOURCE_CHANGED'));
});

test('source edits, policy edits and tampered rules cannot pass freshness',t=>{
  const f=fixture(t,[rule('no-var')]);
  const pack=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  const tampered=structuredClone(pack);tampered.approvedRules[0].check.kind='manual';
  assert.equal(checkTaskContext(f.context,f.catalog,tampered).status,'STALE_CONTEXT');
  // Recomputing an unkeyed hash must not authenticate fabricated requirements.
  const {contextHash,generatedAt,...content}=tampered;tampered.contextHash=digest(content);
  assert.equal(checkTaskContext(f.context,f.catalog,tampered).status,'STALE_CONTEXT');
  fs.writeFileSync(path.join(f.root,'src','main.js'),'const changed = 2;\n');
  assert.equal(checkTaskContext(f.context,f.catalog,pack).status,'STALE_CONTEXT');
  const current=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  const next={...f.catalog,rules:[...f.catalog.rules,rule('debugger','no-debugger')]};
  assert.ok(checkTaskContext(f.context,next,current).changes.some(change=>change.reason==='CATALOG_CHANGED'));
});

test('all-project context detects added files; selected context does not include unrelated files',t=>{
  const f=fixture(t,[rule('no-var')]);
  const whole=createTaskContext(f.context,f.catalog,'app');
  const selected=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  fs.writeFileSync(path.join(f.root,'src','extra.js'),'const extra = 1;\n');
  assert.equal(checkTaskContext(f.context,f.catalog,whole).status,'STALE_CONTEXT');
  assert.equal(checkTaskContext(f.context,f.catalog,selected).status,'CONTEXT_CURRENT');
});

test('context reports exclusions and conflicts without effective conflicting requirements',t=>{
  const f=fixture(t,[rule('variant-one'),rule('variant-two')]);
  const conflict=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  assert.equal(conflict.status,'CONTEXT_INCOMPLETE');assert.equal(conflict.exitCode,2);assert.deepEqual(conflict.approvedRules,[]);
  const excluded=createTaskContext(f.context,f.catalog,'app',{files:['legacy/old.js']});
  assert.equal(excluded.status,'NOT_APPLICABLE');assert.equal(excluded.files.length,0);
  assert.throws(()=>createTaskContext(f.context,f.catalog,'app',{files:['../outside.js']}),/Unsafe relative path/);
  assert.throws(()=>createTaskContext(f.context,f.catalog,'app',{files:['C:\\outside.js']}),/Unsafe relative path/);
});

test('structured examples check positive, negative and parsing cases without executing code',()=>{
  const good=rule('examples','no-var',{examples:[{code:'throw new Error("example must not execute");',expect:'valid'},{code:'var x = 1;',expect:'violation'}]});
  assert.equal(evaluateRuleExamples(good).status,'PASS');
  const bad=rule('bad-examples','no-var',{examples:[{code:'var x = 1;',expect:'valid'}]});
  assert.equal(evaluateRuleExamples(bad).status,'FAIL');
  const parse=rule('broken-example','no-var',{examples:[{code:'const = ;',expect:'violation'}]});
  assert.equal(evaluateRuleExamples(parse).status,'INCOMPLETE');
  const manual=rule('manual-example','manual',{examples:[{code:'const value=1;',expect:'valid'}]});
  assert.equal(evaluateRuleExamples(manual).status,'UNVERIFIED_MANUAL');
  const legacy=rule('legacy-example','no-var',{examples:{good:'const value=1;'}});
  assert.equal(evaluateRuleExamples(legacy).status,'UNVERIFIED_LEGACY');
});

test('context tracks source drift from inherited scopes',t=>{
  const f=fixture(t,[]);
  const doc=path.join(f.root,'parent-policy.md');fs.writeFileSync(doc,'Do not use var.\n');
  f.catalog.rules.push(rule('inherited-no-var','no-var',{scope:'base',evidence:[{kind:'document',path:doc,sha256:sha256(fs.readFileSync(doc))}]}));
  const pack=createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']});
  assert.equal(pack.sourceStates.length,1);assert.equal(pack.sourceStates[0].state,'current');
  fs.writeFileSync(doc,'The team is reviewing the previous agreement.\n');
  const checked=checkTaskContext(f.context,f.catalog,pack);
  assert.equal(checked.status,'STALE_CONTEXT');assert.ok(checked.changes.some(change=>change.reason==='AGREEMENT_SOURCE_CHANGED'));
  assert.equal(createTaskContext(f.context,f.catalog,'app',{files:['src/main.js']}).sourceReviewRequired,true);
});

test('empty and excluded source selections do not create an unfiltered command',t=>{
  const f=fixture(t,[rule('no-var')]);
  const empty=createTaskContext(f.context,f.catalog,'app',{files:[]});
  assert.equal(empty.status,'NOT_APPLICABLE');assert.equal(empty.commands.review,null);assert.equal(empty.commands.refreshContext,null);
  fs.mkdirSync(path.join(f.root,'dist'));fs.writeFileSync(path.join(f.root,'dist','generated.js'),'var generated=1;\n');
  fs.writeFileSync(path.join(f.root,'src','types.d.TS'),'declare const value: number;\n');
  const excluded=createTaskContext(f.context,f.catalog,'app',{files:['dist/generated.js','src/types.d.TS']});
  assert.equal(excluded.status,'NOT_APPLICABLE');assert.equal(excluded.approvedRules.length,0);assert.equal(excluded.commands.review,null);
  assert.throws(()=>createTaskContext(f.context,f.catalog,'app',{files:['src/invalid:name.js']}),/Invalid project-relative file/);
  const report=reviewProject(f.context,f.catalog,'app',{diffText:''});
  const pack=createAgentPack(f.context,f.catalog,report);assert.equal(pack.context.commands.review,null);
});

test('a report from an earlier policy cannot bind to a current agent pack',t=>{
  const f=fixture(t,[]);
  const old=reviewProject(f.context,f.catalog,'app');
  const current={...f.catalog,rules:[rule('new-policy')]};
  const pack=createAgentPack(f.context,current,old);
  assert.equal(pack.reportBinding.matchesContext,false);assert.equal(pack.reportBinding.policyMatches,false);
  const checked=checkTaskContext(f.context,current,pack);
  assert.equal(checked.status,'STALE_CONTEXT');assert.ok(checked.changes.some(change=>change.reason==='REPORT_POLICY_CHANGED'));
});

test('full-project agent packs detect added sources and retain incomplete review state',t=>{
  const f=fixture(t,[rule('no-var')]);
  const report=reviewProject(f.context,f.catalog,'app');
  const pack=createAgentPack(f.context,f.catalog,report);
  fs.writeFileSync(path.join(f.root,'src','added.js'),'var added=1;\n');
  assert.equal(checkTaskContext(f.context,f.catalog,pack).status,'STALE_CONTEXT');
  const staleReportPack=createAgentPack(f.context,f.catalog,report);assert.equal(staleReportPack.reportBinding.matchesContext,false);
  fs.writeFileSync(path.join(f.root,'src','main.js'),'const = ;\n');
  const incomplete=createAgentPack(f.context,f.catalog,reviewProject(f.context,f.catalog,'app'));
  assert.equal(checkTaskContext(f.context,f.catalog,incomplete).status,'INCOMPLETE');
});
