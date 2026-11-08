import fs from 'node:fs';
import path from 'node:path';
import { assert, digest, isObject, sha256 } from './util.mjs';
import { validateRule, logicalRuleKey, stableCandidateId, approveRule, behaviorHash } from './rules.mjs';
import { projectInfo, scopeChain, validateCatalog } from './config.mjs';
import { reviewProject } from './review.mjs';
import { evaluateRuleExamples } from './examples.mjs';

const ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['document','mr','agent-proposal','code','diff','comments']);
const MAX_SOURCES = 20000, MAX_RULES = 20000, MAX_EVIDENCE = 5000, MAX_REVISIONS = 50000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const clone = value => structuredClone(value);
const unique = values => [...new Set(values)];
const same = (a,b) => digest(a) === digest(b);
const boundedText = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
function keys(value, allowed, label) {
  assert(isObject(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${label}: unknown field ${key}`);
}
function timestamp(value, label) { assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label}: invalid timestamp`); }
function evidenceValid(evidence, label) {
  // Match the original v1 rule-evidence contract when observing old catalogs.
  assert(isObject(evidence) && typeof evidence.kind === 'string' && typeof evidence.path === 'string', `${label}: invalid evidence`);
  assert(HASH.test(evidence.sha256), `${label}: evidence SHA-256 is required`);
  assert(evidence.excerpt === undefined || typeof evidence.excerpt === 'string' && evidence.excerpt.length <= 20000, `${label}: invalid excerpt`);
}

/** Optional v1 metadata; it never changes the approval hash of a rule. */
export function validateLifecycleMetadata(catalog, context) {
  if (catalog.lifecycle === undefined) return catalog;
  const value = catalog.lifecycle;
  keys(value, ['schemaVersion','sources','rules','revisions','decisions'], 'Catalog lifecycle');
  assert(value.schemaVersion === 1, 'Unsupported lifecycle metadata version');
  for (const [name,limit] of [['sources',MAX_SOURCES],['rules',MAX_RULES],['revisions',MAX_REVISIONS]]) assert(Array.isArray(value[name]) && value[name].length <= limit, `Invalid lifecycle ${name}`);
  if(value.decisions!==undefined)assert(Array.isArray(value.decisions)&&value.decisions.length<=MAX_REVISIONS,'Invalid lifecycle decisions');
  const knownRules = new Map(catalog.rules.map(rule => [rule.id,rule]));
  const knownScopes = context ? new Set(context.config.scopes.map(scope => scope.id)) : null;
  const sourceIds = new Set(), recordIds = new Set();
  for (const source of value.sources) {
    keys(source, ['id','scope','kind','path','sha256','project','evidencePath','pair','firstImportedAt','lastImportedAt','ruleIds','lastRuleIds','complete'], 'Lifecycle source');
    assert(validId(source.id) && !sourceIds.has(source.id), 'Invalid or duplicate lifecycle source ID'); sourceIds.add(source.id);
    assert(validId(source.scope) && (!knownScopes || knownScopes.has(source.scope)), `Unknown source scope: ${source.scope}`);
    assert(SOURCE_KINDS.has(source.kind) && boundedText(source.path), `${source.id}: invalid source kind/path`);
    assert(HASH.test(source.sha256), `${source.id}: invalid source hash`);
    if (source.project !== undefined) assert(validId(source.project), `${source.id}: invalid project`);
    if (source.evidencePath !== undefined) assert(boundedText(source.evidencePath), `${source.id}: invalid evidence path`);
    if (source.complete !== undefined) assert(typeof source.complete === 'boolean', `${source.id}: invalid completeness flag`);
    timestamp(source.firstImportedAt, source.id); timestamp(source.lastImportedAt, source.id);
    for (const name of ['ruleIds','lastRuleIds']) {
      assert(Array.isArray(source[name]) && source[name].length <= MAX_RULES && unique(source[name]).length === source[name].length, `${source.id}: invalid ${name}`);
      for (const id of source[name]) assert(knownRules.has(id) && knownRules.get(id).scope === source.scope, `${source.id}: unknown or cross-scope rule ${id}`);
    }
    assert(source.lastRuleIds.every(id => source.ruleIds.includes(id)), `${source.id}: lastRuleIds must be observed rules`);
    if (source.pair !== undefined) {
      keys(source.pair, ['id','diffPath','commentsPath'], `${source.id} pair`);
      assert(validId(source.pair.id) && boundedText(source.pair.diffPath) && boundedText(source.pair.commentsPath), `${source.id}: invalid paired input`);
      assert(['diff','comments'].includes(source.kind), `${source.id}: only diff/comments can be paired`);
      assert(source.path === (source.kind === 'diff' ? source.pair.diffPath : source.pair.commentsPath), `${source.id}: mismatched paired input path`);
    }
  }
  for (const record of value.rules) {
    keys(record, ['ruleId','logicalKey','evidence','sourceIds','firstObservedAt','lastObservedAt','projectCoverage','lastObservation','previousDefinitions'], 'Lifecycle rule record');
    assert(knownRules.has(record.ruleId) && !recordIds.has(record.ruleId), 'Unknown or duplicate lifecycle rule record'); recordIds.add(record.ruleId);
    assert(HASH.test(record.logicalKey), `${record.ruleId}: invalid logical key`);
    assert(Array.isArray(record.evidence) && record.evidence.length > 0 && record.evidence.length <= MAX_EVIDENCE, `${record.ruleId}: invalid observed evidence`);
    record.evidence.forEach(e => evidenceValid(e,record.ruleId));
    assert(Array.isArray(record.sourceIds) && record.sourceIds.length <= MAX_SOURCES && unique(record.sourceIds).length === record.sourceIds.length, `${record.ruleId}: invalid source IDs`);
    for (const id of record.sourceIds) assert(sourceIds.has(id)&&value.sources.find(source=>source.id===id).scope===knownRules.get(record.ruleId).scope, `${record.ruleId}: unknown or cross-scope source ${id}`);
    timestamp(record.firstObservedAt,record.ruleId); timestamp(record.lastObservedAt,record.ruleId);
    if (record.projectCoverage !== undefined) {
      assert(Array.isArray(record.projectCoverage) && record.projectCoverage.length <= MAX_SOURCES, `${record.ruleId}: invalid project coverage`);
      for (const row of record.projectCoverage) {
        assert(isObject(row) && validId(row.project) && ['supported','contradicted','insufficient','unobserved'].includes(row.status), `${record.ruleId}: invalid project coverage status`);
        for (const field of ['supported','total','minSamples']) assert(Number.isSafeInteger(row[field]) && row[field] >= 0, `${record.ruleId}: invalid coverage count`);
        assert(row.supported <= row.total && (row.ratio === null || typeof row.ratio === 'number' && row.ratio >= 0 && row.ratio <= 1), `${record.ruleId}: invalid coverage ratio`);
        assert(typeof row.threshold === 'number' && row.threshold > 0 && row.threshold <= 1, `${record.ruleId}: invalid coverage threshold`);
      }
    }
    if (record.lastObservation !== undefined) assert(isObject(record.lastObservation), `${record.ruleId}: invalid last observation`);
    if(record.previousDefinitions!==undefined){
      assert(Array.isArray(record.previousDefinitions)&&record.previousDefinitions.length<=100,`${record.ruleId}: invalid observation version history`);
      for(const prior of record.previousDefinitions){
        keys(prior,['logicalKey','evidence','sourceIds','firstObservedAt','lastObservedAt','projectCoverage','lastObservation'],'Prior lifecycle observations');
        assert(HASH.test(prior.logicalKey)&&Array.isArray(prior.evidence)&&prior.evidence.length>0&&prior.evidence.length<=MAX_EVIDENCE,`${record.ruleId}: invalid prior observation identity/evidence`);
        prior.evidence.forEach(e=>evidenceValid(e,record.ruleId));
        assert(Array.isArray(prior.sourceIds)&&prior.sourceIds.length<=MAX_SOURCES&&prior.sourceIds.every(id=>sourceIds.has(id)&&value.sources.find(source=>source.id===id).scope===knownRules.get(record.ruleId).scope),`${record.ruleId}: invalid prior source references`);
        timestamp(prior.firstObservedAt,record.ruleId);timestamp(prior.lastObservedAt,record.ruleId);
      }
    }
  }
  for (const revision of value.revisions) {
    keys(revision, ['previous','candidate','sourceId','reason','relation','at'], 'Lifecycle revision');
    assert(knownRules.has(revision.previous) && knownRules.has(revision.candidate) && revision.previous !== revision.candidate, 'Invalid lifecycle revision rule reference');
    assert(knownRules.get(revision.previous).scope === knownRules.get(revision.candidate).scope, 'Cross-scope lifecycle revision');
    assert(sourceIds.has(revision.sourceId) && revision.reason === 'SOURCE_RULE_CHANGED' && revision.relation === 'potential-revision', 'Invalid lifecycle revision source/relation');
    timestamp(revision.at,'Lifecycle revision');
  }
  const decisionIds=new Set();
  for(const decision of value.decisions??[]){
    keys(decision,['id','ruleId','from','to','by','reason','at','behaviorHash','preexisting'],'Lifecycle decision');
    assert(validId(decision.id)&&!decisionIds.has(decision.id),'Invalid or duplicate lifecycle decision ID');decisionIds.add(decision.id);
    assert(knownRules.has(decision.ruleId)&&['candidate','approved','rejected'].includes(decision.to),'Invalid lifecycle decision rule/state');
    assert(decision.from===null||['candidate','approved','rejected'].includes(decision.from),'Invalid lifecycle prior state');
    assert(boundedText(decision.by,1000)&&typeof decision.reason==='string'&&decision.reason.trim()&&decision.reason.length<=20000,'Invalid lifecycle decision actor/reason');
    if(decision.at!==undefined)timestamp(decision.at,'Lifecycle decision');
    assert(decision.behaviorHash===undefined||HASH.test(decision.behaviorHash),'Invalid lifecycle decision hash');
    assert(decision.preexisting===undefined||typeof decision.preexisting==='boolean','Invalid lifecycle preexisting marker');
  }
  return catalog;
}

export function sourceIdentity(source, scope = source.scope) {
  return `source-${digest({scope,kind:source.kind,path:source.path,project:source.project ?? null,pair:source.pair ?? null}).slice(0,32)}`;
}
function newRuleRecord(rule, at) {
  return {ruleId:rule.id,logicalKey:logicalRuleKey(rule),evidence:clone(rule.evidence),sourceIds:[],firstObservedAt:at,lastObservedAt:at};
}
function matchesSource(evidence, source) {
  if (source.kind === 'code') return evidence.kind === 'code' && evidence.path === source.evidencePath;
  if (source.kind === 'diff') return evidence.kind === 'mr' && evidence.diffPath === source.path && (!source.pair || evidence.path === source.pair.commentsPath);
  if (source.kind === 'comments') return evidence.kind === 'mr' && evidence.path === source.path && (!source.pair || evidence.diffPath === source.pair.diffPath);
  if (source.kind === 'mr') return evidence.kind === 'mr' && evidence.path === source.path && !evidence.diffPath;
  return evidence.kind === 'document' && evidence.path === source.path;
}
function addEvidence(record, additions) {
  const seen = new Set(record.evidence.map(digest));
  let added = 0;
  for (const evidence of additions) {
    const key = digest(evidence);
    if (seen.has(key)) continue;
    assert(record.evidence.length < MAX_EVIDENCE, `${record.ruleId}: lifecycle evidence limit reached; import was not committed`);
    record.evidence.push(clone(evidence)); seen.add(key); added++;
  }
  return added;
}
function potentialRevision(previous, candidate, source) {
  if (previous.scope !== candidate.scope || logicalRuleKey(previous) === logicalRuleKey(candidate)) return false;
  if (previous.family === candidate.family) return true;
  const before = previous.evidence.filter(e => matchesSource(e,source));
  const after = candidate.evidence.filter(e => matchesSource(e,source));
  const sameComment = before.some(a => a.commentId !== undefined && after.some(b => a.commentId === b.commentId && a.discussionId === b.discussionId));
  if (sameComment) return true;
  // For prose/manual clauses a stable source position is only a suggested link,
  // never evidence that the newer statement supersedes the approved agreement.
  return previous.check.kind === 'manual' && candidate.check.kind === 'manual' && before.some(a => a.line !== undefined && after.some(b => a.line === b.line));
}

/** Mutate only the in-memory catalog supplied by mutateCatalog's transaction. */
export function mergeLearnedCandidates(context, catalog, scope, candidates, inputs, {proposalCoverage = [], at = new Date().toISOString()} = {}) {
  validateLifecycleMetadata(catalog,context);
  const metadata = catalog.lifecycle ??= {schemaVersion:1,sources:[],rules:[],revisions:[],decisions:[]};
  for (const rule of catalog.rules) if (!metadata.rules.some(record => record.ruleId === rule.id)) metadata.rules.push(newRuleRecord(rule,at));
  const previousSources = new Map(), currentSources = [],sourcesById=new Map(metadata.sources.map(source=>[source.id,source]));
  for (const input of inputs) {
    const descriptor = {scope,kind:input.kind,path:input.path};
    for (const field of ['project','evidencePath','pair']) if (input[field] !== undefined) descriptor[field] = clone(input[field]);
    const id = sourceIdentity(descriptor);
    let source = sourcesById.get(id);
    if (!source) {
      assert(metadata.sources.length < MAX_SOURCES, 'Lifecycle source limit reached; import was not committed');
      source = {id,...descriptor,sha256:input.sha256,firstImportedAt:at,lastImportedAt:at,ruleIds:[],lastRuleIds:[],complete:input.complete !== false};
      const existing=catalog.rules.filter(rule=>rule.scope===scope&&rule.evidence.some(evidence=>matchesSource(evidence,source)));
      if(existing.length){
        source.ruleIds=existing.map(rule=>rule.id).sort();source.lastRuleIds=[...source.ruleIds];
        const evidence=existing.flatMap(rule=>rule.evidence).find(item=>matchesSource(item,source));
        previousSources.set(id,{...clone(source),sha256:source.kind==='diff'?evidence.diffSha256??evidence.sha256:evidence.sha256});
      }
      metadata.sources.push(source);sourcesById.set(id,source);
    } else previousSources.set(id,clone(source));
    currentSources.push({source,input});
  }
  const byLogical = new Map();
  for (const rule of catalog.rules) {
    const key = logicalRuleKey(rule), group = byLogical.get(key) ?? [];
    group.push(rule); byLogical.set(key,group);
  }
  const added = [], unchanged = [], revisions = [], warnings = [], observations = new Map(), sourceRules = new Map(currentSources.map(({source}) => [source.id,new Set()]));
  const aliases = new Map(), touchedRules = new Set();
  for (const candidate of candidates) {
    validateRule(candidate);
    assert(candidate.status === 'candidate' && candidate.scope === scope, 'Extractor cannot approve or change the target scope');
    const key = logicalRuleKey(candidate), matches = byLogical.get(key) ?? [];
    if (matches.length > 1 && !warnings.some(w => w.logicalKey === key)) warnings.push({reason:'EXISTING_LOGICAL_DUPLICATES',logicalKey:key,ruleIds:matches.map(r => r.id),message:'Existing decisions were preserved. Resolve duplicate legacy records explicitly.'});
    const rank = {approved:0,rejected:1,candidate:2};
    let rule = [...matches].sort((a,b) => rank[a.status]-rank[b.status] || a.id.localeCompare(b.id))[0];
    const wasExisting = Boolean(rule);
    if (!rule) {
      let id = stableCandidateId(candidate);
      if (catalog.rules.some(existing => existing.id === id)) id = `${id.slice(0,140)}-${digest({key,occupied:catalog.rules.find(existing => existing.id === id)}).slice(0,12)}`;
      assert(!catalog.rules.some(existing => existing.id === id), 'Logical rule ID collision; import was not committed');
      rule = {...clone(candidate),id};
      catalog.rules.push(rule); metadata.rules.push(newRuleRecord(rule,at)); byLogical.set(key,[rule]); added.push(id);
    }
    aliases.set(candidate.id,rule.id); touchedRules.add(rule.id);
    const record = metadata.rules.find(item => item.ruleId === rule.id);
    let redefined=false;
    if(record.logicalKey!==key){
      // A user may explicitly edit/reapprove a legacy ID. Never attribute its
      // earlier observations to the different current policy automatically.
      const {ruleId,previousDefinitions,...prior}=record;
      record.previousDefinitions??=[];
      assert(record.previousDefinitions.length<100,`${rule.id}: observation version limit reached; import was not committed`);
      record.previousDefinitions.push(clone(prior));
      record.logicalKey=key;record.evidence=clone(candidate.evidence);record.sourceIds=[];
      record.firstObservedAt=at;record.lastObservedAt=at;
      delete record.projectCoverage;delete record.lastObservation;redefined=true;
      warnings.push({reason:'RULE_LOGICAL_IDENTITY_CHANGED',ruleId:rule.id,previousLogicalKey:prior.logicalKey,logicalKey:key,message:'The record was explicitly edited under its existing ID. Prior observations were preserved separately; no approval was changed.'});
    }
    const addedEvidence = addEvidence(record,candidate.evidence)+(redefined?candidate.evidence.length:0);
    if (wasExisting && addedEvidence) observations.set(rule.id,(observations.get(rule.id) ?? 0)+addedEvidence);
    if (addedEvidence) record.lastObservedAt = at;
    const coverage = proposalCoverage.find(item => item.ruleId === candidate.id)?.projects;
    if (coverage && !same(record.projectCoverage ?? [],coverage)) {record.projectCoverage=clone(coverage);record.lastObservedAt=at;}
    if (candidate.observations !== undefined) {
      const observation = {observations:candidate.observations,...(candidate.confidence === undefined ? {} : {confidence:candidate.confidence})};
      if (!same(record.lastObservation ?? {},observation)) {record.lastObservation=clone(observation);record.lastObservedAt=at;}
    }
    // New observations do not amend an approved/rejected object or its v1 hash.
    if (rule.status === 'candidate') {
      rule.evidence = clone(record.evidence.slice(0,500));
      if (candidate.observations !== undefined) {rule.description=candidate.description;rule.observations=clone(candidate.observations);if(candidate.confidence!==undefined)rule.confidence=candidate.confidence;}
    }
    for (const {source} of currentSources) if (candidate.evidence.some(evidence => matchesSource(evidence,source))) {
      sourceRules.get(source.id).add(rule.id);
      if (!record.sourceIds.includes(source.id)) {record.sourceIds.push(source.id);record.lastObservedAt=at;}
    }
  }
  for (const {source,input} of currentSources) {
    const previous = previousSources.get(source.id);
    const latest = [...sourceRules.get(source.id)].sort();
    if (!previous || previous.sha256 !== input.sha256 || !same(previous.lastRuleIds,latest) || previous.complete !== (input.complete !== false)) source.lastImportedAt=at;
    source.sha256=input.sha256;source.complete=input.complete!==false;source.ruleIds=unique([...source.ruleIds,...latest]).sort();source.lastRuleIds=latest;
    if (!previous || !source.complete || previous.sha256 === source.sha256) continue;
    const retired = previous.lastRuleIds.filter(id => !latest.includes(id));
    const retiredApproved=retired.filter(id=>catalog.rules.find(rule=>rule.id===id)?.status==='approved');
    if(retiredApproved.length)warnings.push({reason:'SOURCE_RULE_NOT_REOBSERVED',sourceId:source.id,path:source.path,ruleIds:retiredApproved,message:'Previously approved rules were not reobserved in this source. Their decisions remain unchanged; review the changed authority explicitly.'});
    const introduced = latest.filter(id => !previous.lastRuleIds.includes(id));
    for (const previousId of retired) for (const candidateId of introduced) {
      const old = catalog.rules.find(rule => rule.id === previousId), next = catalog.rules.find(rule => rule.id === candidateId);
      if (!potentialRevision(old,next,source)) continue;
      if (metadata.revisions.some(link => link.previous===previousId && link.candidate===candidateId && link.sourceId===source.id)) continue;
      assert(metadata.revisions.length < MAX_REVISIONS, 'Lifecycle revision limit reached; import was not committed');
      const link={previous:previousId,candidate:candidateId,sourceId:source.id,reason:'SOURCE_RULE_CHANGED',relation:'potential-revision',at};
      metadata.revisions.push(link);revisions.push(clone(link));
    }
  }
  for (const id of touchedRules) if (!added.includes(id)) unchanged.push(id);
  validateLifecycleMetadata(catalog,context);
  return {added,unchanged,revisions,mergedEvidence:[...observations].map(([ruleId,addedEvidence])=>({ruleId,addedEvidence})),warnings,sources:unique(currentSources.map(({source})=>source.id)),aliases:Object.fromEntries(aliases)};
}

function legacySources(context, catalog, registered) {
  const sources=[];
  for (const rule of catalog.rules) for (const evidence of rule.evidence) {
    if (registered.some(source => source.scope === rule.scope && matchesSource(evidence,source))) continue;
    let filename=evidence.path, project;
    if (evidence.kind === 'code') {
      const found=context.config.projects.find(p=>evidence.path.startsWith(p.id+'/'));
      if (found) {project=found.id;filename=path.resolve(context.baseDir,found.root,evidence.path.slice(found.id.length+1));}
    }
    const kind=evidence.kind==='code'?'code':evidence.kind==='mr'?'mr':'document';
    const descriptor={scope:rule.scope,kind,path:filename,...(project?{project,evidencePath:evidence.path}:{})};
    const id=`legacy-${digest({descriptor,sha256:evidence.sha256}).slice(0,32)}`;
    let source=sources.find(s=>s.id===id);
    if(!source){source={id,...descriptor,sha256:evidence.sha256,ruleIds:[],lastRuleIds:[],registered:false};sources.push(source);}
    source.ruleIds=unique([...source.ruleIds,rule.id]);source.lastRuleIds=[...source.ruleIds];
  }
  return sources;
}
function inspectSource(source) {
  const result={...clone(source),registered:source.registered!==false,importedSha256:source.sha256,observedSha256:source.sha256,currentSha256:null,state:'unavailable'};
  // Do not reinterpret a Windows absolute path as a relative POSIX path, or
  // guess the base of an unregistered relative legacy source reference.
  if (!path.isAbsolute(source.path)) {result.reason='SOURCE_PATH_NOT_RESOLVABLE_ON_THIS_PLATFORM';return result;}
  try {
    const stat=fs.lstatSync(source.path);
    if(!stat.isFile()){result.reason=stat.isSymbolicLink()?'SOURCE_SYMLINK_NOT_FOLLOWED':'SOURCE_NOT_REGULAR_FILE';return result;}
    if(stat.size>MAX_SOURCE_BYTES){result.reason='SOURCE_TOO_LARGE';return result;}
    result.currentSha256=sha256(fs.readFileSync(source.path));
    result.state=result.currentSha256===source.sha256?'current':'changed';
    result.reason=result.state==='current'?'MATCHES_LAST_IMPORTED_BYTES':'SOURCE_BYTES_CHANGED';
  } catch(error) {result.state=['ENOENT','ENOTDIR'].includes(error.code)?'missing':'unavailable';result.reason=error.code??'SOURCE_READ_ERROR';}
  return result;
}
/** Read current bytes only; never rewrite metadata or approval decisions. */
export function sourceStatus(context,catalog,{scope,sourceId}={}) {
  validateLifecycleMetadata(catalog,context);
  if(scope)scopeChain(context.config,scope);
  const registered=catalog.lifecycle?.sources??[];
  let sources=[...registered,...legacySources(context,catalog,registered)];
  if(scope)sources=sources.filter(source=>source.scope===scope);
  if(sourceId){assert(sources.some(source=>source.id===sourceId),`Unknown source: ${sourceId}`);sources=sources.filter(source=>source.id===sourceId);}
  const currentKeys=new Map(catalog.rules.map(rule=>[rule.id,logicalRuleKey(rule)]));
  const records=new Map((catalog.lifecycle?.rules??[]).map(record=>[record.ruleId,record]));
  sources=sources.map(source=>{
    const inspected=inspectSource(source);
    inspected.unobservedApprovedRuleIds=source.ruleIds.filter(id=>{
      if(catalog.rules.find(rule=>rule.id===id)?.status!=='approved')return false;
      const observed=records.get(id);
      return !source.lastRuleIds.includes(id)||observed&&(observed.logicalKey!==currentKeys.get(id)||source.registered!==false&&!observed.sourceIds.includes(source.id));
    });
    inspected.requiresReview=inspected.state!=='current'||inspected.unobservedApprovedRuleIds.length>0||source.complete===false;
    return inspected;
  });
  const summary={total:sources.length,current:0,changed:0,missing:0,unavailable:0,unregistered:sources.filter(source=>!source.registered).length,requiresReview:sources.filter(source=>source.requiresReview).length,unobservedApprovedRules:unique(sources.flatMap(source=>source.unobservedApprovedRuleIds)).length};
  for(const source of sources)summary[source.state]++;
  return {schemaVersion:1,readOnly:true,status:summary.requiresReview?'SOURCES_REQUIRE_ATTENTION':sources.length?'SOURCES_CURRENT':'NO_REGISTERED_SOURCES',sources,summary,note:'Freshness compares current bytes with the last imported snapshot. It does not approve new evidence or invalidate a prior decision automatically.'};
}
export function refreshSources(context,catalog,options={}) { return sourceStatus(context,catalog,options); }

/** Called inside the explicit CLI approval/rejection transaction, never by learn. */
export function recordRuleDecision(catalog,ruleId,{from,to,by,reason,at,behaviorHash:hash,before}={}){
  const rule=catalog.rules.find(item=>item.id===ruleId);assert(rule,`Unknown rule: ${ruleId}`);
  assert(rule.status===to,'Decision history must describe the explicitly stored rule state');
  const metadata=catalog.lifecycle??={schemaVersion:1,sources:[],rules:[],revisions:[],decisions:[]};
  metadata.decisions??=[];
  const append=decision=>{
    const value={id:`decision-${digest(decision).slice(0,32)}`,...decision};
    if(!metadata.decisions.some(item=>item.id===value.id)){assert(metadata.decisions.length<MAX_REVISIONS,'Lifecycle decision history limit reached');metadata.decisions.push(value);}
    return value;
  };
  if(before&&!metadata.decisions.some(decision=>decision.ruleId===ruleId)){
    const old=before.status==='approved'?before.approval:before.status==='rejected'?before.rejection:null;
    if(old?.by&&old?.reason){
      const decision={ruleId,from:null,to:before.status,by:old.by,reason:old.reason,preexisting:true};
      if(old.at!==undefined)decision.at=old.at;
      if(before.status==='approved'&&before.approval?.behaviorHash)decision.behaviorHash=before.approval.behaviorHash;
      append(decision);
    }
  }
  const decision={ruleId,from,to,by,reason};if(at!==undefined)decision.at=at;if(hash!==undefined)decision.behaviorHash=hash;
  const recorded=append(decision);validateLifecycleMetadata(catalog);return clone(recorded);
}

export function ruleHistory(context,catalog,ruleId) {
  validateLifecycleMetadata(catalog,context);
  const rule=catalog.rules.find(item=>item.id===ruleId);assert(rule,`Unknown rule: ${ruleId}`);
  const related=new Set([ruleId]);let changed=true;
  while(changed){changed=false;for(const link of catalog.lifecycle?.revisions??[])if(related.has(link.previous)||related.has(link.candidate)){for(const id of [link.previous,link.candidate])if(!related.has(id)){related.add(id);changed=true;}}}
  const record=catalog.lifecycle?.rules.find(item=>item.ruleId===ruleId);
  return {schemaVersion:1,readOnly:true,rule:clone(rule),logicalKey:logicalRuleKey(rule),logicalIdentityChanged:Boolean(record&&record.logicalKey!==logicalRuleKey(rule)),approvalCurrent:rule.status==='approved'?rule.approval?.behaviorHash===behaviorHash(rule):null,
    observation:record?clone(record):newRuleRecord(rule,rule.createdAt??rule.approval?.at??new Date().toISOString()),
    revisions:clone((catalog.lifecycle?.revisions??[]).filter(link=>related.has(link.previous)&&related.has(link.candidate))),
    decisions:clone((catalog.lifecycle?.decisions??[]).filter(decision=>related.has(decision.ruleId))),
    relatedRules:catalog.rules.filter(item=>related.has(item.id)).map(item=>({id:item.id,status:item.status,title:item.title,check:clone(item.check)})),
    sources:sourceStatus(context,catalog).sources.filter(source=>source.ruleIds.some(id=>related.has(id))),
    note:'Observed evidence and potential revision links are not approval, rejection, or an override. The original rule and decision remain authoritative until explicitly changed.'};
}

/** A hypothetical activation in an isolated clone, never a persisted decision. */
export function previewRule(context,catalog,ruleId,{projectId,scope,files,...reviewOptions}={}) {
  validateCatalog(context,catalog);
  assert(!reviewOptions.newOnly && Object.getOwnPropertySymbols(reviewOptions).length === 0, 'Rule preview uses current files or a supplied diff, not a Git snapshot or new-only baseline. Select explicit files for hypothetical policy review.');
  const original=catalog.rules.find(rule=>rule.id===ruleId);assert(original,`Unknown rule: ${ruleId}`);
  assert(!(projectId&&scope),'Preview accepts a project or a scope, not both');
  let projects=projectId?[projectInfo(context,projectId)]:context.config.projects.filter(project=>!scope||project.scope===scope);
  if(scope)scopeChain(context.config,scope);
  projects=projects.filter(project=>scopeChain(context.config,project.scope).includes(original.scope));
  assert(projects.length>0,'The rule has no selected project in its scope or descendants');
  assert(projects.length===1||reviewOptions.diffText===undefined,'Diff preview requires one project');
  const simulated=clone(catalog), index=simulated.rules.findIndex(rule=>rule.id===ruleId);
  simulated.rules[index]=approveRule(original,'SelfReview preview only','Read-only hypothetical activation; no decision was stored');
  const reports=projects.map(project=>({...reviewProject(context,simulated,project.id,{...reviewOptions,...(files===undefined?{}:{files})}),hypothetical:true,previewRuleId:ruleId}));
  const findings=reports.flatMap(report=>report.findings.filter(finding=>finding.ruleId===ruleId));
  const conflicts=reports.flatMap(report=>report.errors.filter(error=>error.reason==='RULE_CONFLICT'||Array.isArray(error.ids)&&typeof error.family==='string').map(error=>({project:report.project,...error})));
  return {schemaVersion:1,status:reports.some(report=>report.exitCode===2)?'PREVIEW_INCOMPLETE':'PREVIEW_READY',readOnly:true,decisionStored:false,
    rule:{id:original.id,status:original.status,title:original.title,scope:original.scope,check:clone(original.check),applicability:clone(original.applicability??{include:['**/*'],exclude:[]})},
    reports,summary:{projects:reports.length,selectedFiles:reports.reduce((n,report)=>n+report.coverage.selectedFiles,0),candidateFindings:findings.length,conflicts:conflicts.length,manualItems:reports.reduce((n,report)=>n+report.manualChecklist.filter(item=>item.id===ruleId).length,0)},findings,conflicts,
    examples:evaluateRuleExamples(original),note:'This simulates activation against current files without saving an approval. Conflicts remain visible and no rule is automatically replaced.'};
}
