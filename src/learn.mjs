import fs from 'node:fs';
import path from 'node:path';
import { analyzeSource } from './ast.mjs';
import { extractDocument, importMr, discoverConventions } from './ingest.mjs';
import { projectInfo, mutateCatalog, scopeChain } from './config.mjs';
import { validateRule } from './rules.mjs';
import { walk, sha256, assert, contained, posix, digest } from './util.mjs';

function readText(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length <= 8*1024*1024, `Input exceeds 8 MiB: ${file}`);
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),hash:sha256(bytes)};
}
function inputFiles(inputs,warnings) {
  const files = [];
  for (const value of inputs) {
    const absolute = path.resolve(value);
    assert(fs.existsSync(absolute), `Input not found: ${absolute}`);
    if (fs.statSync(absolute).isDirectory()) {
      const inventory = walk(absolute,{include:['**/*'],extensions:null,maxBytes:8*1024*1024,maxFiles:1000});
      for (const f of inventory.files) files.push(f.absolute);
      warnings.push(...inventory.errors,...inventory.skipped);
    } else files.push(absolute);
  }
  return [...new Set(files)];
}
export function learnScope(context,scope,{docs=[],mrs=[],diff,comments,proposals=[],code=true,codePaths=[],minSamples=5,threshold=0.9}={}) {
  scopeChain(context.config,scope);
  const candidates=[],warnings=[],unmapped=[],records=[],inputs=[],sourceCoverage=[];
  let discovery=null;
  const merge = (result,source) => {
    assert(result && Array.isArray(result.candidates), `Invalid extractor output: ${source}`);
    candidates.push(...result.candidates); warnings.push(...(result.warnings??[])); unmapped.push(...(result.unmapped??[]));
    if(result.coverage)sourceCoverage.push({source,...result.coverage});
  };
  if (code) {
    const projects = context.config.projects.filter(p=>p.scope===scope);
    assert(projects.length>0,'No projects directly assigned to this scope');
    const roots = codePaths.map(p=>fs.realpathSync(path.resolve(p)));
    for (const root of roots) assert(projects.some(p=>contained(projectInfo(context,p.id).root,root)), `Code path is outside selected scope: ${root}`);
    for (const p of projects) {
      const project = projectInfo(context,p.id), inventory = walk(project.root,{include:project.include,exclude:project.exclude});
      warnings.push(...inventory.errors.map(e=>({...e,project:p.id})),...inventory.skipped.map(e=>({...e,project:p.id})));
      for (const file of inventory.files) {
        if (roots.length && !roots.some(r=>contained(r,file.absolute))) continue;
        const result = analyzeSource(file.source,file.path,[]);
        if (result.parseErrors.length) { warnings.push({project:p.id,path:file.path,reason:'PARSE_ERROR',details:result.parseErrors}); continue; }
        records.push({path:`${p.id}/${file.path}`,hash:file.hash,metrics:result.metrics});
      }
    }
    const inferred=discoverConventions(records,{scope,minSamples,threshold});
    discovery={aggregate:inferred.observations,byProject:projects.map(p=>{
      const analysis=discoverConventions(records.filter(r=>r.path.startsWith(p.id+'/')),{scope,minSamples,threshold});
      return {project:p.id,observations:analysis.observations,coverage:analysis.coverage,suggestedChecks:analysis.candidates.map(r=>r.check)};
    }),samplePaths:roots,note:'Sampling restricts observations, not the candidate scope. Review applicability before approval; per-project profiles can reveal inconsistent conventions.'};
    discovery.withheldCandidates=[];
    inferred.candidates=inferred.candidates.filter(rule=>{
      const contradictions=[];
      for(const profile of discovery.byProject){
        const obs=profile.observations;let supported=0,total=0;
        if(rule.check.kind==='no-var'){supported=obs.declarations.const+obs.declarations.let;total=supported+obs.declarations.var;}
        if(rule.check.kind==='require-braces'){supported=obs.braces.braced;total=supported+obs.braces.unbraced;}
        if(rule.check.kind==='strict-equality'){supported=obs.equality.strict+(rule.check.options?.allowNull?obs.equality.nullLoose:0);total=obs.equality.strict+obs.equality.loose;}
        if(total>=minSamples&&supported/total<threshold)contradictions.push({project:profile.project,supported,total,ratio:supported/total});
      }
      if(!contradictions.length)return true;
      const held={check:rule.check,reason:'MIXED_PROJECT_CONVENTIONS',contradictions};
      discovery.withheldCandidates.push(held);warnings.push(held);return false;
    });
    merge(inferred,'static discovery');
  }
  for (const file of inputFiles(docs,warnings)) {
    if (!['.md','.txt','.json'].includes(path.extname(file).toLowerCase())) { warnings.push({path:file,reason:'UNSUPPORTED_DOCUMENT_FORMAT',message:'Export document as UTF-8 Markdown/text or rule JSON.'}); continue; }
    const {text,hash}=readText(file); inputs.push({path:file,sha256:hash,kind:'document'});
    const value = path.extname(file).toLowerCase()==='.json' ? '```selfreview-rule\n'+text+'\n```' : text;
    const extracted=extractDocument(value,{scope,sourcePath:file,sourceHash:hash});
    if(path.extname(file).toLowerCase()==='.json')for(const rule of extracted.candidates)for(const evidence of rule.evidence)delete evidence.line;
    merge(extracted,file);
  }
  for (const file of inputFiles(mrs,warnings)) {
    const {text,hash}=readText(file); inputs.push({path:file,sha256:hash,kind:'mr'});
    let data;
    if (path.extname(file).toLowerCase()==='.json') data=JSON.parse(text.replace(/^\uFEFF/,''));
    else if (['.diff','.patch'].includes(path.extname(file))) data={diff:text,comments:[]};
    else data={comments:[{body:text}]};
    merge(importMr(data,{scope,sourcePath:file,sourceHash:hash}),file);
  }
  if (diff || comments) {
    assert(diff && comments,'Paired import requires both --diff and --comments');
    const d=readText(path.resolve(diff)),c=readText(path.resolve(comments));
    let list; try { list=JSON.parse(c.text); } catch { list=[{body:c.text}]; }
    const data={diff:d.text,comments:Array.isArray(list)?list:list.comments??list};
    const result=importMr(data,{scope,sourcePath:path.resolve(comments),sourceHash:c.hash});
    for (const rule of result.candidates) for (const e of rule.evidence) {e.diffPath=path.resolve(diff);e.diffSha256=d.hash;}
    inputs.push({path:path.resolve(diff),sha256:d.hash,kind:'diff'},{path:path.resolve(comments),sha256:c.hash,kind:'comments'});
    merge(result,comments);
  }
  for (const file of inputFiles(proposals,warnings)) {
    const {text,hash}=readText(file);
    const parsed=JSON.parse(text.replace(/^\uFEFF/,''));
    const normalized=Array.isArray(parsed)?parsed:parsed.rules??parsed;
    inputs.push({path:file,sha256:hash,kind:'agent-proposal'});
    const extracted=extractDocument('```selfreview-rule\n'+JSON.stringify(normalized)+'\n```',{scope,sourcePath:file,sourceHash:hash});
    for(const rule of extracted.candidates)for(const evidence of rule.evidence)delete evidence.line;
    merge(extracted,file);
  }
  const unique=new Map();
  for (const candidate of candidates) { validateRule(candidate); assert(candidate.status==='candidate' && candidate.scope===scope,'Extractor cannot approve or change the target scope'); unique.set(candidate.id,candidate); }
  const added=[],unchanged=[],revisions=[];
  mutateCatalog(context,catalog=>{
    for (const rule of unique.values()) {
      const existing=catalog.rules.find(r=>r.id===rule.id);
      if (!existing) {catalog.rules.push(rule);added.push(rule.id);continue;}
      const plain=r=>{const {status,approval,rejection,createdAt,...rest}=r;return rest;};
      if (digest(plain(existing))===digest(plain(rule))) {unchanged.push(rule.id);continue;}
      // Never overwrite an approved/rejected version during re-import.
      const revised={...rule,id:`${rule.id.slice(0,140)}-${digest(plain(rule)).slice(0,10)}`};
      if (!catalog.rules.some(r=>r.id===revised.id)) {catalog.rules.push(revised);revisions.push({previous:rule.id,candidate:revised.id});}
      else unchanged.push(revised.id);
    }
  });
  return {schemaVersion:1,scope,status:warnings.length?'CANDIDATES_WITH_COVERAGE_GAPS':'CANDIDATES_READY',added,unchanged,revisions,
    codeFilesAnalyzed:records.length,inputs,unmapped,warnings,discovery,sourceCoverage,coverage:{exhaustive:false,approvedAutomatically:0,discoveryFamilies:['no-var','strict-equality','require-braces'],naturalLanguage:'Conservative templates plus manual candidates; interpretation needs review.'}};
}
