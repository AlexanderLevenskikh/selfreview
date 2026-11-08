import fs from 'node:fs';
import path from 'node:path';
import { analyzeSource } from './ast.mjs';
import { extractDocument, importMr, discoverConventions } from './ingest.mjs';
import { projectInfo, mutateCatalog, scopeChain, loadCatalog } from './config.mjs';
import { mergeLearnedCandidates, sourceStatus } from './lifecycle.mjs';
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
function proposalProjectCoverage(check, profiles, minSamples, threshold, sampled) {
  return profiles.map(profile => {
    const obs=profile.observations ?? {}, declarations=obs.declarations??{}, equality=obs.equality??{}, braces=obs.braces??{};
    let supported=0,total=0;
    if(check.kind==='no-var'){supported=(declarations.const??0)+(declarations.let??0);total=supported+(declarations.var??0);}
    if(check.kind==='strict-equality'){supported=(equality.strict??0)+(check.options?.allowNull?(equality.nullLoose??0):0);total=(equality.strict??0)+(equality.loose??0);}
    if(check.kind==='require-braces'){supported=braces.braced??0;total=supported+(braces.unbraced??0);}
    const ratio=total?supported/total:null;
    const status=!total?'unobserved':total<minSamples?'insufficient':ratio>=threshold?'supported':'contradicted';
    return {project:profile.project,status,supported,total,ratio,minSamples,threshold,...(!sampled||profile.sampled===false?{reason:'CODE_NOT_SAMPLED'}:!['no-var','strict-equality','require-braces'].includes(check.kind)?{reason:'CHECK_NOT_PROFILED'}:{})};
  });
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
        const input={path:file.absolute,evidencePath:`${p.id}/${file.path}`,sha256:file.hash,kind:'code',project:p.id,complete:true};inputs.push(input);
        const result = analyzeSource(file.source,file.path,[]);
        if (result.parseErrors.length) { input.complete=false;warnings.push({project:p.id,path:file.path,reason:'PARSE_ERROR',details:result.parseErrors}); continue; }
        records.push({path:`${p.id}/${file.path}`,hash:file.hash,metrics:result.metrics});
      }
    }
    const inferred=discoverConventions(records,{scope,minSamples,threshold});
    discovery={aggregate:inferred.observations,byProject:projects.map(p=>{
      const analysis=discoverConventions(records.filter(r=>r.path.startsWith(p.id+'/')),{scope,minSamples,threshold});
      return {project:p.id,observations:analysis.observations,coverage:analysis.coverage,suggestedChecks:analysis.candidates.map(r=>r.check)};
    }),samplePaths:roots,note:'Sampling restricts observations, not the candidate scope. Review applicability before approval; per-project profiles can reveal inconsistent conventions.'};
    discovery.withheldCandidates=[];
    discovery.proposals=inferred.candidates.map(rule=>({ruleId:rule.id,check:rule.check,projects:proposalProjectCoverage(rule.check,discovery.byProject,minSamples,threshold,true)}));
    inferred.candidates=inferred.candidates.filter(rule=>{
      const projectCoverage=discovery.proposals.find(proposal=>proposal.ruleId===rule.id).projects;
      const contradictions=projectCoverage.filter(profile=>profile.status==='contradicted').map(({project,supported,total,ratio})=>({project,supported,total,ratio}));
      if(!contradictions.length)return true;
      const held={check:rule.check,reason:'MIXED_PROJECT_CONVENTIONS',contradictions,projectCoverage};
      discovery.withheldCandidates.push(held);warnings.push(held);return false;
    });
    merge(inferred,'static discovery');
  }
  for (const file of inputFiles(docs,warnings)) {
    if (!['.md','.txt','.json'].includes(path.extname(file).toLowerCase())) { warnings.push({path:file,reason:'UNSUPPORTED_DOCUMENT_FORMAT',message:'Export document as UTF-8 Markdown/text or rule JSON.'}); continue; }
    const {text,hash}=readText(file);const input={path:file,sha256:hash,kind:'document'};inputs.push(input);
    const value = path.extname(file).toLowerCase()==='.json' ? '```selfreview-rule\n'+text+'\n```' : text;
    const extracted=extractDocument(value,{scope,sourcePath:file,sourceHash:hash});
    input.complete=extracted.coverage?.complete!==false;
    if(path.extname(file).toLowerCase()==='.json')for(const rule of extracted.candidates)for(const evidence of rule.evidence)delete evidence.line;
    merge(extracted,file);
  }
  for (const file of inputFiles(mrs,warnings)) {
    const {text,hash}=readText(file);const input={path:file,sha256:hash,kind:'mr'};inputs.push(input);
    let data;
    if (path.extname(file).toLowerCase()==='.json') data=JSON.parse(text.replace(/^\uFEFF/,''));
    else if (['.diff','.patch'].includes(path.extname(file))) data={diff:text,comments:[]};
    else data={comments:[{body:text}]};
    const extracted=importMr(data,{scope,sourcePath:file,sourceHash:hash});input.complete=extracted.coverage?.complete!==false;merge(extracted,file);
  }
  if (diff || comments) {
    assert(diff && comments,'Paired import requires both --diff and --comments');
    const d=readText(path.resolve(diff)),c=readText(path.resolve(comments));
    let list; try { list=JSON.parse(c.text); } catch { list=[{body:c.text}]; }
    const data={diff:d.text,comments:Array.isArray(list)?list:list.comments??list};
    const result=importMr(data,{scope,sourcePath:path.resolve(comments),sourceHash:c.hash});
    for (const rule of result.candidates) for (const e of rule.evidence) {e.diffPath=path.resolve(diff);e.diffSha256=d.hash;}
    const diffPath=path.resolve(diff),commentsPath=path.resolve(comments),pair={id:`pair-${digest({scope,diffPath,commentsPath}).slice(0,32)}`,diffPath,commentsPath};
    inputs.push({path:diffPath,sha256:d.hash,kind:'diff',pair,complete:result.coverage?.complete!==false},{path:commentsPath,sha256:c.hash,kind:'comments',pair,complete:result.coverage?.complete!==false});
    merge(result,comments);
  }
  for (const file of inputFiles(proposals,warnings)) {
    const {text,hash}=readText(file);
    const parsed=JSON.parse(text.replace(/^\uFEFF/,''));
    const normalized=Array.isArray(parsed)?parsed:parsed.rules??parsed;
    const input={path:file,sha256:hash,kind:'agent-proposal'};inputs.push(input);
    const extracted=extractDocument('```selfreview-rule\n'+JSON.stringify(normalized)+'\n```',{scope,sourcePath:file,sourceHash:hash});
    input.complete=extracted.coverage?.complete!==false;
    for(const rule of extracted.candidates)for(const evidence of rule.evidence)delete evidence.line;
    merge(extracted,file);
  }
  const profiles=context.config.projects.filter(project=>scopeChain(context.config,project.scope).includes(scope)).map(project=>discovery?.byProject.find(profile=>profile.project===project.id)??{project:project.id,sampled:false});
  const proposalCoverage=[...new Map(candidates.map(rule=>[rule.id,{ruleId:rule.id,check:rule.check,projects:proposalProjectCoverage(rule.check,profiles,minSamples,threshold,code)}])).values()];
  const merged=mutateCatalog(context,catalog=>mergeLearnedCandidates(context,catalog,scope,candidates,inputs,{proposalCoverage}));
  warnings.push(...merged.warnings);
  for(const proposal of proposalCoverage)proposal.ruleId=merged.aliases[proposal.ruleId]??proposal.ruleId;
  for(const item of unmapped)item.ruleId=merged.aliases[item.ruleId]??item.ruleId;
  const complete=inputs.every(input=>input.complete!==false)&&sourceCoverage.every(item=>item.complete!==false)&&!warnings.some(warning=>typeof warning==='object'&&(['PARSE_ERROR','UNSUPPORTED_DOCUMENT_FORMAT','FILE_LIMIT','FILE_TOO_LARGE','SYMLINK_NOT_FOLLOWED'].includes(warning.reason)||String(warning.reason).startsWith('READ_ERROR')));
  return {schemaVersion:1,scope,status:warnings.length?'CANDIDATES_WITH_COVERAGE_GAPS':'CANDIDATES_READY',added:merged.added,unchanged:merged.unchanged,revisions:merged.revisions,mergedEvidence:merged.mergedEvidence,sources:merged.sources,
    codeFilesAnalyzed:records.length,inputs,unmapped,warnings,discovery,proposalCoverage,sourceCoverage,coverage:{complete,exhaustive:false,approvedAutomatically:0,discoveryFamilies:['no-var','strict-equality','require-braces'],naturalLanguage:'Conservative templates plus manual candidates; interpretation needs review.'}};
}

/** Re-import only registered files. Directory discovery and code mining stay explicit. */
export function refreshScope(context,scope) {
  scopeChain(context.config,scope);
  const before=sourceStatus(context,loadCatalog(context),{scope}),reports=[],warnings=[],skipped=[],handled=new Set();
  const eligible=source=>source.registered&&['current','changed'].includes(source.state);
  for(const source of before.sources) {
    if(handled.has(source.id))continue;
    if(source.kind==='code'){skipped.push({id:source.id,path:source.path,reason:'CODE_REQUIRES_EXPLICIT_LEARN'});handled.add(source.id);continue;}
    if(!eligible(source)){warnings.push({id:source.id,path:source.path,reason:source.registered?'SOURCE_NOT_READABLE':'SOURCE_NOT_REGISTERED',state:source.state});handled.add(source.id);continue;}
    let options={code:false};
    if(source.kind==='document')options.docs=[source.path];
    else if(source.kind==='mr')options.mrs=[source.path];
    else if(source.kind==='agent-proposal')options.proposals=[source.path];
    else if(['diff','comments'].includes(source.kind)){
      const pair=source.pair;
      const members=pair?before.sources.filter(item=>item.pair?.id===pair.id):[];
      const diffSource=members.find(item=>item.kind==='diff'&&item.path===pair.diffPath);
      const commentsSource=members.find(item=>item.kind==='comments'&&item.path===pair.commentsPath);
      members.forEach(item=>handled.add(item.id));
      if(!diffSource||!commentsSource||!eligible(diffSource)||!eligible(commentsSource)){
        warnings.push({id:source.id,path:source.path,reason:'PAIRED_SOURCE_REFRESH_UNAVAILABLE',message:'The original diff and comments must both be registered and readable; no context was invented.'});continue;
      }
      options.diff=pair.diffPath;options.comments=pair.commentsPath;
    } else {warnings.push({id:source.id,path:source.path,reason:'UNSUPPORTED_SOURCE_REFRESH'});handled.add(source.id);continue;}
    handled.add(source.id);
    try{reports.push(learnScope(context,scope,options));}
    catch(error){warnings.push({id:source.id,path:source.path,reason:'SOURCE_IMPORT_FAILED',message:error.message});}
  }
  const after=sourceStatus(context,loadCatalog(context),{scope});
  const incomplete=warnings.length>0||reports.some(report=>report.coverage.complete===false)||before.sources.some(source=>source.registered&&['missing','unavailable'].includes(source.state));
  return {schemaVersion:1,scope,status:incomplete?'SOURCE_REFRESH_INCOMPLETE':'SOURCES_REFRESHED',exitCode:incomplete?2:0,readOnly:false,approvedAutomatically:0,
    reports,added:uniqueIds(reports.flatMap(report=>report.added)),unchanged:uniqueIds(reports.flatMap(report=>report.unchanged)),revisions:reports.flatMap(report=>report.revisions),warnings:[...warnings,...reports.flatMap(report=>report.warnings)],skipped,sources:after.sources,summary:after.summary,
    note:'Registered document/MR/proposal files were re-imported. Approved/rejected rule objects were preserved. Code sampling and new files in previously supplied folders require an explicit learn command.'};
}
function uniqueIds(values){return [...new Set(values)];}
