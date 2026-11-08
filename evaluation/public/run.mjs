import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as espree from 'espree';
import tsParser from '@typescript-eslint/parser';
import { analyzeSource } from '../../src/ast.mjs';
import { discoverConventions } from '../../src/ingest.mjs';
import { BEST_PRACTICES } from '../../src/rules.mjs';
import { walk, writeJson, digest, sha256 } from '../../src/util.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const plan=JSON.parse(fs.readFileSync(path.join(here,'plan.json'),'utf8'));
const checkoutRoot=process.argv[2] ? path.resolve(process.argv[2]) : null;
const provenancePath=path.join(here,'provenance.json');
const prior=fs.existsSync(provenancePath)?JSON.parse(fs.readFileSync(provenancePath,'utf8')):null;
const reports=[],provenance=[];

// Independent traversal: Espree parses JS; typescript-eslint exposes ESTree for TS.
// The TS path still uses TypeScript underneath, so it is an independent counter,
// not an independent TypeScript parser implementation.
function recount(source,filename) {
  const tree=/\.[cm]?tsx?$/.test(filename)
    ? tsParser.parse(source,{filePath:filename,sourceType:'module',ecmaVersion:'latest',loc:true})
    : espree.parse(source,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},loc:true});
  const metrics={declarations:{const:0,let:0,var:0},equality:{strict:0,loose:0,nullLoose:0},braces:{braced:0,unbraced:0}};
  const isNull=node=>{while(node&&['TSAsExpression','TSTypeAssertion','TSNonNullExpression','TSSatisfiesExpression','ChainExpression'].includes(node.type))node=node.expression;return node?.type==='Literal'&&node.value===null;};
  const body=node=>{if(node)metrics.braces[node.type==='BlockStatement'?'braced':'unbraced']++;};
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='VariableDeclaration'&&Object.hasOwn(metrics.declarations,node.kind))metrics.declarations[node.kind]+=node.declarations.length;
    if(node.type==='BinaryExpression'){
      if(['===','!=='].includes(node.operator))metrics.equality.strict++;
      if(['==','!='].includes(node.operator)){metrics.equality.loose++;if(isNull(node.left)||isNull(node.right))metrics.equality.nullLoose++;}
    }
    if(node.type==='IfStatement'){body(node.consequent);if(node.alternate?.type!=='IfStatement')body(node.alternate);}
    if(['ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement'].includes(node.type))body(node.body);
    for(const [key,value]of Object.entries(node)){
      if(['loc','range','tokens','comments','parent'].includes(key))continue;
      if(Array.isArray(value)) {
        for(const child of value)if(child&&typeof child.type==='string')visit(child);
      } else if(value&&typeof value.type==='string')visit(value);
    }
  };visit(tree);return metrics;
}

for(const repo of plan.repositories){
  const root=checkoutRoot?path.join(checkoutRoot,repo.id):path.join(here,'corpus',repo.id);
  const revision=checkoutRoot?execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim():prior.repositories.find(r=>r.id===repo.id).revision;
  if(repo.revision&&revision!==repo.revision)throw new Error(`Unexpected revision ${repo.id}: ${revision}`);
  const inventory=walk(root,{include:repo.include,exclude:repo.exclude});
  if(!inventory.files.length)throw new Error(`Predeclared source selection is empty: ${repo.id}`);
  const records=[],parseFailures=[],counterFailures=[],sources=[],advice=[],aggregate={declarations:{const:0,let:0,var:0},equality:{strict:0,loose:0,nullLoose:0},braces:{braced:0,unbraced:0}};
  let analysisMs=0;
  for(const file of inventory.files){
    const expected=prior?.repositories.find(r=>r.id===repo.id)?.files.find(f=>f.path===file.path);
    if(!checkoutRoot&&expected?.sha256!==file.hash)throw new Error(`Corpus digest mismatch: ${repo.id}/${file.path}`);
    const start=performance.now(),analysis=analyzeSource(file.source,file.path,BEST_PRACTICES);analysisMs+=performance.now()-start;
    sources.push({path:file.path,sha256:file.hash,bytes:Buffer.byteLength(file.source)});
    if(analysis.parseErrors.length){parseFailures.push({path:file.path,errors:analysis.parseErrors});continue;}
    records.push({path:file.path,hash:file.hash,metrics:analysis.metrics});
    for(const group of Object.keys(aggregate))for(const key of Object.keys(aggregate[group]))aggregate[group][key]+=analysis.metrics[group][key];
    try{
      const observed=recount(file.source,file.path);
      for(const group of Object.keys(aggregate))if(digest(observed[group])!==digest(analysis.metrics[group]))counterFailures.push({path:file.path,group,core:analysis.metrics[group],independent:observed[group]});
    }catch(error){counterFailures.push({path:file.path,error:error.message});}
    advice.push(...analysis.findings.map(f=>({path:file.path,line:f.startLine,ruleId:f.ruleId,symbol:f.symbol,message:f.message})));
    if(checkoutRoot){const target=path.join(here,'corpus',repo.id,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.source);}
  }
  if(checkoutRoot)for(const name of ['LICENSE','license','LICENSE.md'])if(fs.existsSync(path.join(root,name)))fs.copyFileSync(path.join(root,name),path.join(here,'corpus',repo.id,name));
  const discovery=discoverConventions(records,{scope:repo.id,...plan.settings});
  const counts={};for(const f of advice)counts[f.ruleId]=(counts[f.ruleId]??0)+1;
  reports.push({id:repo.id,url:repo.url,revision,files:inventory.files.length,parsedFiles:records.length,sourceBytes:sources.reduce((n,f)=>n+f.bytes,0),analysisMs:Math.round(analysisMs),
    parseFailures,counterFailures,inventoryErrors:inventory.errors,skipped:inventory.skipped,metrics:aggregate,
    observations:discovery.observations,candidates:discovery.candidates.map(c=>({id:c.id,check:c.check,status:c.status,observations:c.observations,description:c.description})),
    adviceCounts:counts,adviceSamples:advice.slice(0,30),allAdvice:advice,limits:discovery.coverage});
  provenance.push({id:repo.id,url:repo.url,revision,selection:{include:repo.include,exclude:repo.exclude},files:sources});
}
const failed=reports.some(r=>r.parseFailures.length||r.counterFailures.length||r.inventoryErrors.length);
const result={schemaVersion:1,createdAt:new Date().toISOString(),planHash:digest(plan),status:failed?'OBSERVATION_MISMATCH_OR_INCOMPLETE':'OBSERVATIONS_MATCH_IN_SELECTED_CORPUS',
  environment:{node:process.version,platform:process.platform,coreParser:'typescript 5.9.3',independentJsParser:'Espree',tsRecount:'typescript-eslint ESTree; shared TypeScript parser underneath'},
  scope:'Read-only source observation; not actual convention authority, runtime correctness or generic recall benchmark',reports};
if(checkoutRoot)writeJson(provenancePath,{schemaVersion:1,planHash:digest(plan),repositories:provenance});
writeJson(path.join(here,'results.json'),result);
console.log(JSON.stringify({status:result.status,repositories:reports.map(({id,revision,files,parsedFiles,counterFailures,metrics,candidates,adviceCounts,analysisMs})=>({id,revision,files,parsedFiles,counterFailures:counterFailures.length,metrics,candidates:candidates.map(c=>c.check),adviceCounts,analysisMs}))},null,2));
process.exitCode=failed?2:0;
