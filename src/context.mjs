import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo, resolveRules, validateCatalog, scopeChain } from './config.mjs';
import { behaviorHash } from './rules.mjs';
import { sourceStatus } from './lifecycle.mjs';
import { evaluateRuleExamples } from './examples.mjs';
import { diffFromGit, projectRelativeFile, isSourcePath } from './git.mjs';
import { AGENT_WORKFLOW, DATA_NOTE } from './agent-guidance.mjs';
import { assert, digest, safeRelative, matches, walk, sha256, EXCLUDED_DIRS, VERSION, isObject } from './util.mjs';

const cliPath=fileURLToPath(new URL('../bin/selfreview.mjs',import.meta.url));

function selectedPath(value) {
  const relative=path.posix.normalize(safeRelative(value));
  assert(relative!=='.' && relative!=='', 'Select a project-relative file, not its directory');
  return projectRelativeFile(relative);
}

function snapshotFile(root,relative) {
  let absolute=root;
  for (const component of relative.split('/')) {
    absolute=path.join(absolute,component);
    try {
      const stat=fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(),`Selected source is a symlink: ${relative}`);
    } catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  let stat;
  try {stat=fs.statSync(absolute);} catch(error) {if(error.code==='ENOENT')return {path:relative,state:'planned',sha256:null};throw error;}
  assert(stat.isFile(),`Selected source is not a regular file: ${relative}`);
  assert(stat.size<=2*1024*1024,`Selected source exceeds 2 MiB: ${relative}`);
  const bytes=fs.readFileSync(absolute);
  const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return {path:relative,state:'existing',sha256:sha256(bytes),lines:source.split(/\r?\n/).length};
}

function ruleView(rule) {
  return {id:rule.id,family:rule.family,title:rule.title,description:rule.description,scope:rule.scope,status:rule.status,
    severity:rule.severity,mode:rule.mode,check:rule.check,applicability:rule.applicability??{include:['**/*'],exclude:[]},
    overrides:rule.overrides??[],overrideReason:rule.overrideReason,behaviorHash:behaviorHash(rule),
    evidence:rule.evidence.slice(0,5).map(item=>({...item,excerpt:item.excerpt?.slice(0,800)})),evidenceCount:rule.evidence.length,
    examples:evaluateRuleExamples(rule)};
}

function seal(value) {const {contextHash,generatedAt,...content}=value;return digest(content);}

export function bindReportToContext(report,context) {
  const policyMismatches=[];
  for(const field of ['configHash','catalogHash','project','scope'])if(report[field]!==context[field])policyMismatches.push(field);
  const contextSources=new Map(context.files.map(source=>[source.path,source.sha256]));
  const reportSources=new Map((report.sources??[]).map(source=>[source.path,source.sha256]));
  const mismatchedFiles=[...new Set([...contextSources.keys(),...reportSources.keys()])].filter(name=>contextSources.get(name)!==reportSources.get(name));
  return {policyMatches:policyMismatches.length===0,policyMismatches,matchesContext:policyMismatches.length===0&&mismatchedFiles.length===0,
    mismatchedFiles,reportTarget:report.git?.target??'working-tree',contextSourceState:'working-tree',reportFreshness:'NOT_RECHECKED',
    note:'Binding compares declared policy and source snapshots. A staged report may differ from the working-tree context. Check saved-pack freshness before reusing it; neither binding nor hashes authenticate review results.'};
}

/** Prepare explicit file-specific constraints. New files are allowed as planned paths. */
export function createTaskContext(context,catalog,projectId,{files}={}) {
  validateCatalog(context,catalog);
  const project=projectInfo(context,projectId);
  assert(files===undefined || (Array.isArray(files)&&files.length<=10000),'files must be a bounded array of project-relative paths');
  const errors=[],skipped=[];
  let paths;
  if (files===undefined) {
    const inventory=walk(project.root,{include:project.include,exclude:project.exclude});
    paths=inventory.files.map(file=>file.path);errors.push(...inventory.errors);skipped.push(...inventory.skipped);
    for(const item of inventory.skipped.filter(item=>item.reason==='SYMLINK_NOT_FOLLOWED'))errors.push({...item,reason:'SOURCE_SYMLINK_NOT_ANALYZED'});
  } else paths=[...new Set(files.map(selectedPath))].sort();
  const selected=[],approved=new Map(),advice=new Map(),questions=new Map(),manual=new Map(),suppressed=[];
  for (const relative of paths) {
    if(relative.split('/').slice(0,-1).some(part=>EXCLUDED_DIRS.has(part))){skipped.push({path:relative,reason:'EXCLUDED_DIRECTORY'});continue;}
    if (!matches(relative,project.include,project.exclude)) {skipped.push({path:relative,reason:'EXCLUDED_BY_PROJECT_CONFIG'});continue;}
    if (!isSourcePath(relative)) {skipped.push({path:relative,reason:'OUTSIDE_JS_TS_COVERAGE'});continue;}
    let source;
    try {source=snapshotFile(project.root,relative);} catch(error) {errors.push({path:relative,reason:'SOURCE_UNAVAILABLE',message:error.message});continue;}
    const resolved=resolveRules(context.config,catalog,project.scope,relative);
    for(const conflict of resolved.conflicts)errors.push({path:relative,reason:'RULE_CONFLICT',...conflict});
    for(const item of resolved.suppressed)suppressed.push({path:relative,...item});
    const active=resolved.conflicts.length?[]:resolved.rules;
    const applicableCandidates=resolved.candidates.filter(rule=>matches(relative,rule.applicability?.include,rule.applicability?.exclude));
    selected.push({...source,effectiveRuleIds:active.map(rule=>rule.id).sort(),candidateIds:applicableCandidates.map(rule=>rule.id).sort()});
    for(const rule of active) {
      (rule.scope==='builtin'?advice:approved).set(rule.id,ruleView(rule));
      if(rule.check.kind==='manual') {
        const entry=manual.get(rule.id)??{id:rule.id,title:rule.title,description:rule.description,files:[],expectedAnswer:'Explain whether the change satisfies this rule, cite the relevant file and lines, and state any uncertainty or work not reviewed.'};
        entry.files.push({path:relative,startLine:source.state==='existing'?1:null,endLine:source.lines??null});manual.set(rule.id,entry);
      }
    }
    for(const rule of applicableCandidates){const entry=questions.get(rule.id)??{...ruleView(rule),files:[]};entry.files.push(relative);questions.set(rule.id,entry);}
  }
  const applicableSources=scopeChain(context.config,project.scope).flatMap(scope=>sourceStatus(context,catalog,{scope}).sources??[]);
  const sourceStates=applicableSources.map(source=>({id:source.id,path:source.path,kind:source.kind,state:source.state,
    recordedSha256:source.sha256??source.recordedSha256,currentSha256:source.currentSha256??source.actualSha256??source.observedSha256,
    unobservedApprovedRuleIds:source.unobservedApprovedRuleIds??[],requiresReview:source.requiresReview??source.state!=='current'}));
  const invocation=['--config',context.absolute,'--project',project.id];
  const selectionArgs=files===undefined?[]:paths.flatMap(relative=>['--file',relative]);
  const result={schemaVersion:1,kind:'selfreview-task-context',toolVersion:VERSION,
    status:errors.length?'CONTEXT_INCOMPLETE':!selected.length?'NOT_APPLICABLE':'CONTEXT_READY',exitCode:errors.length?2:0,
    project:project.id,scope:project.scope,projectRoot:project.root,configPath:context.absolute,catalogPath:context.catalogPath,
    configHash:context.hash,catalogHash:digest(catalog),selection:{mode:files===undefined?'project':'files',paths},
    sourceState:'working-tree',files:selected,approvedRules:[...approved.values()],bestPractices:[...advice.values()],
    candidateQuestions:[...questions.values()],manualChecklist:[...manual.values()],suppressed,errors,skipped,sourceStates,
    sourceReviewRequired:sourceStates.some(source=>source.requiresReview||source.unobservedApprovedRuleIds.length),instructions:AGENT_WORKFLOW,trustBoundary:DATA_NOTE,
    commands:!selected.length?{review:null,refreshContext:null,reason:'NO_SELECTED_SOURCE_FILES'}:
      {review:{executable:process.execPath,args:[cliPath,'review',...invocation,...selectionArgs,'--format','json'],cwd:project.root},
      refreshContext:{executable:process.execPath,args:[cliPath,'context',...invocation,...selectionArgs,'--format','json'],cwd:project.root}},
    responseContract:{verification:'Report the actual review result and project checks run/not run.',manual:'Answer each applicable manual question with file references; unanswered questions remain unverified.',policy:'Candidate proposals and source drift require explicit decisions; never change approvals automatically.'},
    limitations:['Context describes configured syntax conventions and manual questions; it does not prove architecture, types or runtime behavior.',
      'Evidence excerpts are bounded; use rule history for all observations. Example checks do not establish file applicability.',
      'Validate saved context before editing. Source changes after editing require a fresh review and a regenerated context.'],
    generatedAt:new Date().toISOString()};
  result.contextHash=seal(result);return result;
}

/** Verify against current trusted config/catalog and current source bytes, not a supplied hash alone. */
export function checkTaskContext(context,catalog,value) {
  const saved=value?.kind==='selfreview-task-context'?value:value?.context;
  assert(isObject(saved)&&saved.schemaVersion===1&&saved.kind==='selfreview-task-context','Expected a SelfReview task context or agent pack containing one');
  assert(isObject(saved.selection)&&['project','files'].includes(saved.selection.mode)&&Array.isArray(saved.selection.paths)&&saved.selection.paths.length<=10000,'Invalid saved context selection');
  const changes=[];
  if(saved.contextHash!==seal(saved))changes.push({reason:'CONTEXT_CONTENT_CHANGED'});
  const current=createTaskContext(context,catalog,saved.project,{files:saved.selection.mode==='files'?saved.selection.paths:undefined});
  if(saved.configHash!==current.configHash||saved.configPath!==current.configPath)changes.push({reason:'CONFIG_CHANGED'});
  if(saved.catalogHash!==current.catalogHash||saved.catalogPath!==current.catalogPath)changes.push({reason:'CATALOG_CHANGED'});
  const oldSources=new Map((saved.files??[]).map(file=>[file.path,file]));
  const newSources=new Map(current.files.map(file=>[file.path,file]));
  for(const relative of new Set([...oldSources.keys(),...newSources.keys()])) {
    const old=oldSources.get(relative),next=newSources.get(relative);
    if(old?.sha256!==next?.sha256||old?.state!==next?.state)changes.push({path:relative,reason:'SOURCE_CHANGED',previous:old?.sha256??null,current:next?.sha256??null});
  }
  if(digest(saved.sourceStates??[])!==digest(current.sourceStates))changes.push({reason:'AGREEMENT_SOURCE_CHANGED'});
  if(saved.contextHash!==current.contextHash&&!changes.length)changes.push({reason:'CONTEXT_BINDING_CHANGED'});
  const errors=[...current.errors];
  let reportBinding;
  if(value?.report) {
    reportBinding=bindReportToContext(value.report,current);
    if(!reportBinding.policyMatches)changes.push({reason:'REPORT_POLICY_CHANGED',fields:reportBinding.policyMismatches});
    if(reportBinding.reportTarget==='working-tree'&&reportBinding.mismatchedFiles.length)changes.push({reason:'REPORT_SOURCES_CHANGED',paths:reportBinding.mismatchedFiles});
    if(value.report.exitCode===2)errors.push({reason:'SAVED_REPORT_INCOMPLETE',message:'A saved incomplete review is not upgraded by context freshness.'});
    if(value.report.git) {
      try {
        const previous=value.report.git;
        const fresh=diffFromGit(current.projectRoot,previous.requestedBase,{mergeBase:previous.baseMode==='merge-base',staged:previous.target==='index'}).git;
        const fields=['requestedBase','resolvedBase','headCommit','baseCommit','baseMode','target','diffSha256','indexSha256','postimages'];
        const different=fields.filter(field=>digest(previous[field]??null)!==digest(fresh[field]??null));
        reportBinding.reportFreshness=different.length?'STALE_GIT_SNAPSHOT':previous.target==='index'?'CURRENT_INDEX_SNAPSHOT':'CURRENT_WORKING_TREE_SNAPSHOT';
        if(different.length)changes.push({reason:'REPORT_GIT_SNAPSHOT_CHANGED',fields:different});
      } catch(error) {reportBinding.reportFreshness='INCOMPLETE';errors.push({reason:'REPORT_GIT_SNAPSHOT_UNAVAILABLE',message:error.message});}
    } else reportBinding.reportFreshness=reportBinding.matchesContext?'SOURCE_AND_POLICY_MATCH_ONLY':'STALE_SOURCES_OR_POLICY';
  }
  const status=errors.length?'INCOMPLETE':changes.length?'STALE_CONTEXT':'CONTEXT_CURRENT';
  return {schemaVersion:1,status,exitCode:status==='CONTEXT_CURRENT'?0:2,project:current.project,scope:current.scope,
    contextHash:saved.contextHash,currentContextHash:current.contextHash,changes,errors,...(reportBinding?{reportBinding}:{}),readOnly:true,
    note:'Freshness is a consistency check, not an authentication signature or code approval.'};
}
