import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeSource } from './ast.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { projectInfo, resolveRules, validateCatalog } from './config.mjs';
import { VERSION, walk, matches, digest, assert, posix, EXTENSIONS } from './util.mjs';

export function diffFromGit(projectRoot, base) {
  assert(typeof base === 'string' && /^[A-Za-z0-9_./~^@{}-]+$/.test(base) && !base.startsWith('-'), 'Invalid Git base ref');
  const nullDevice=process.platform==='win32'?'NUL':'/dev/null';
  const env={...process.env,GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG_COUNT'])delete env[key];
  const prefix=['-c','core.fsmonitor=false','-c',`core.hooksPath=${nullDevice}`];
  const options = {cwd:projectRoot,env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe']};
  const git=args=>execFileSync('git',[...prefix,...args],options);
  // The root is inside the worktree and has an empty relative prefix. Let Git
  // resolve Windows aliases/casing instead of comparing absolute path strings.
  const location = git(['rev-parse','--is-inside-work-tree','--show-prefix']).replace(/\r\n/g,'\n');
  assert(location === 'true\n\n', 'The configured project must be the Git root; refusing to inspect a parent repository');
  // Even --no-textconv can otherwise invoke configured clean/process filters.
  // Inspect names only, then disable those commands for this subprocess.
  let filterKeys='';
  try {filterKeys=git(['config','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$']);}
  catch(error){if(error.status!==1)throw error;}
  for(const key of filterKeys.split(/\r?\n/).filter(Boolean))prefix.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
  git(['rev-parse','--verify',`${base}^{commit}`]);
  const diffText = git(['-c','core.quotePath=false','diff','--no-ext-diff','--no-textconv','--unified=0',base,'--']);
  const untracked = git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  return {diffText,untracked,diffOrigin:'local-git'};
}
export function reviewProject(context,catalog,projectId,{diffText,untracked = [],diffOrigin = 'provided'} = {}) {
  validateCatalog(context,catalog);
  const started = performance.now(), project = projectInfo(context,projectId);
  const diff = diffText === undefined ? null : parseUnifiedDiff(diffText);
  const onlyPaths = diff ? new Set([...diff.files.filter(f=>!f.deleted&&f.newPath).map(f=>f.newPath),...untracked.map(posix)]) : undefined;
  const inventory = walk(project.root,{include:project.include,exclude:project.exclude,onlyPaths});
  const errors = [...inventory.errors], skipped = [...inventory.skipped], findings = [], manual = new Map(), suppressed = [], sources = [];
  for (const message of diff?.errors ?? []) errors.push({reason:'INVALID_DIFF',message});
  let selected = inventory.files;
  const touched = new Map();
  if (diff) {
    for (const file of diff.files) {
      if (file.deleted) { skipped.push({path:file.oldPath,reason:'DELETED_FILE_NO_POSTIMAGE'}); continue; }
      const name = file.newPath;
      if (!name) { errors.push({reason:'DIFF_PATH_MISSING'}); continue; }
      if (!EXTENSIONS.has(path.extname(name).toLowerCase())) { skipped.push({path:name,reason:'OUTSIDE_JS_TS_COVERAGE'}); continue; }
      if (!matches(name,project.include,project.exclude)) { skipped.push({path:name,reason:'EXCLUDED_BY_PROJECT_CONFIG'}); continue; }
      if (touched.has(name)) { errors.push({path:name,reason:'DUPLICATE_DIFF_FILE'}); continue; }
      touched.set(name,file);
      const source = inventory.files.find(f => f.path === name);
      if (!source) { errors.push({path:name,reason:'DIFF_POSTIMAGE_MISSING_OR_NOT_READABLE'}); continue; }
      if (file.binary) { errors.push({path:name,reason:'BINARY_DIFF_UNSUPPORTED'}); continue; }
      const lines = source.source.split(/\r?\n/);
      if ((file.touchedRanges??[]).some(r=>r.start>lines.length||r.end>lines.length)) errors.push({path:name,reason:'DIFF_RANGE_OUTSIDE_POSTIMAGE'});
      if(file.metadataOnly)file.touchedRanges=[{start:1,end:lines.length}];
      else if(!(file.newLineContent??[]).length && diffOrigin!=='local-git')errors.push({path:name,reason:'DIFF_POSTIMAGE_UNVERIFIABLE',message:'Deletion-only patch has no new-side/context lines. Use a fresh --base review or a diff with context.'});
      for (const content of file.newLineContent ?? []) {
        if (lines[content.line-1] !== content.text) { errors.push({path:name,line:content.line,reason:'STALE_DIFF_POSTIMAGE_MISMATCH'}); break; }
      }
    }
    for (const name of untracked) {
      const normalized = posix(name);
      if (!matches(normalized,project.include,project.exclude)) continue;
      const source = inventory.files.find(f => f.path === normalized);
      if (source) touched.set(normalized,{touchedRanges:[{start:1,end:source.source.split('\n').length}],untracked:true});
      else if (EXTENSIONS.has(path.extname(normalized))) errors.push({path:normalized,reason:'UNTRACKED_FILE_NOT_READABLE'});
    }
    selected = inventory.files.filter(f => touched.has(f.path));
  }
  let parsedFiles = 0; const activeRuleIds = new Set(), enforceRuleIds = new Set(), candidateIds = new Set();
  for (const file of selected) {
    const resolved = resolveRules(context.config,catalog,project.scope,file.path);
    for (const c of resolved.conflicts) errors.push({path:file.path,reason:'RULE_CONFLICT',...c});
    for (const s of resolved.suppressed) suppressed.push({path:file.path,...s});
    for (const c of resolved.candidates) candidateIds.add(c.id);
    for (const rule of resolved.rules) {
      activeRuleIds.add(rule.id);
      if (rule.mode === 'enforce' && rule.check.kind !== 'manual') enforceRuleIds.add(rule.id);
      if (rule.check.kind === 'manual') manual.set(rule.id,{id:rule.id,title:rule.title,description:rule.description,scope:rule.scope,evidence:rule.evidence});
    }
    const analysis = analyzeSource(file.source,file.path,resolved.conflicts.length?[]:resolved.rules);
    sources.push({path:file.path,sha256:file.hash});
    if (analysis.parseErrors.length) errors.push(...analysis.parseErrors.map(e => ({path:file.path,reason:'PARSE_ERROR',...e})));
    else parsedFiles++;
    const ranges = touched.get(file.path)?.touchedRanges;
    for (const finding of analysis.findings) {
      if (ranges && !ranges.some(r => finding.startLine <= r.end && finding.endLine >= r.start)) continue;
      findings.push({...finding,project:project.id,path:file.path,scope:project.scope,changeRelation:diff?'touches-change':'not-compared',sourceHash:file.hash});
    }
  }
  // A link may contain selected source; never call that a complete scan.
  for (const skip of inventory.skipped.filter(s => s.reason === 'SYMLINK_NOT_FOLLOWED')) {
    if (!diff || [...touched.keys()].some(p=>p===skip.path||p.startsWith(skip.path+'/'))) errors.push({path:skip.path,reason:'SOURCE_SYMLINK_NOT_ANALYZED'});
  }
  findings.sort((a,b) => a.path.localeCompare(b.path,'en') || a.startLine-b.startLine || a.ruleId.localeCompare(b.ruleId,'en'));
  const blocking = findings.filter(f => f.mode === 'enforce' && f.severity === 'error').length;
  const emptyDiff = diff && diff.files.length === 0 && untracked.length === 0;
  if (!selected.length && !emptyDiff) errors.push({reason:'NO_ANALYZABLE_FILES',message:'No selected JS/TS files; this is not a passed review.'});
  const status = errors.length ? 'INCOMPLETE' : blocking ? 'VIOLATIONS' : emptyDiff ? 'NO_CHANGES' : manual.size ? 'MANUAL_REVIEW_REQUIRED' : !enforceRuleIds.size ? 'ADVISORY_ONLY' : 'CHECKS_PASSED';
  return {schemaVersion:1,tool:{name:'SelfReview',version:VERSION},project:project.id,scope:project.scope,
    status,exitCode:errors.length?2:blocking?1:0,authority:'STATIC_SYNTAX_ONLY',resultScope:diff?'changed-node-ranges':'selected-files',diffCorrelation:diff?(diffOrigin==='local-git'?'LOCAL_GIT_DIFF':'SUPPLIED_NEW_SIDE_LINES_ONLY'):null,
    configHash:context.hash,catalogHash:digest(catalog),generatedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),
    coverage:{discoveredFiles:inventory.files.length,selectedFiles:selected.length,parsedFiles,activeRules:activeRuleIds.size,enforcedAstRules:enforceRuleIds.size,candidateRulesNotEnforced:candidateIds.size,manualRules:manual.size,skippedFiles:skipped.length,fullProjectTypeCheck:false,runtimeTests:false},
    findings,errors,skipped,suppressed,manualChecklist:[...manual.values()],sources,
    limitations:['Only configured JS/TS syntax checks are evaluated; no proof of architecture, business logic, type safety or runtime correctness.', 'Changed-node findings may predate this change. New-regression attribution requires a baseline analysis.', 'Natural-language conventions require an agent or human review; candidate rules are not enforced.'],
    warnings:diff?.warnings ?? []};
}
export function renderReport(report) {
  const lines = [`SelfReview ${VERSION} | ${report.project} | scope: ${report.scope}`,`${report.status} | exit ${report.exitCode} | ${report.authority}`,
    `Files: ${report.coverage.parsedFiles}/${report.coverage.selectedFiles} parsed; enforced AST rules: ${report.coverage.enforcedAstRules}; candidates: ${report.coverage.candidateRulesNotEnforced}; manual: ${report.coverage.manualRules}`];
  for (const f of report.findings.filter(f=>f.mode!=='advisory')) lines.push(`${f.severity.toUpperCase()} ${f.path}:${f.startLine}:${f.column} [${f.ruleId}] ${f.message}`);
  const adviceGroups=new Map();
  for(const finding of report.findings.filter(f=>f.mode==='advisory')){const group=adviceGroups.get(finding.ruleId)??[];group.push(finding);adviceGroups.set(finding.ruleId,group);}
  for(const [ruleId,group] of adviceGroups){
    lines.push(`ADVICE [${ruleId}] ${group.length} occurrence(s) in ${new Set(group.map(f=>f.path)).size} file(s).`);
    for(const f of group.slice(0,3))lines.push(`  ${f.path}:${f.startLine}:${f.column} ${f.message}`);
    if(group.length>3)lines.push(`  ${group.length-3} additional occurrence(s); all findings are retained by --format json.`);
  }
  for (const e of report.errors) lines.push(`INCOMPLETE ${e.path??''} ${e.reason}: ${e.message??e.family??''}`);
  for (const m of report.manualChecklist) lines.push(`MANUAL [${m.id}] ${m.title}`);
  if (!report.findings.length) lines.push('No findings from the evaluated checks. This is not a guarantee of overall code quality.');
  if (report.resultScope === 'changed-node-ranges') lines.push('Diff mode: findings touch changed nodes; they are not proven newly introduced.');
  lines.push('Coverage: JS/TS syntax only. Build, types, tests, runtime and semantic review remain separate.');
  return lines.join('\n')+'\n';
}
