import fs from 'node:fs';
import path from 'node:path';
import { analyzeSource } from './ast.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { projectInfo, resolveRules, validateCatalog } from './config.mjs';
import { compareFindings, effectivePolicy } from './baseline.mjs';
import { gitComparison, projectRelativeFile, isSourcePath } from './git.mjs';
import { VERSION, walk, matches, digest, assert, posix, contained, EXCLUDED_DIRS } from './util.mjs';

export { diffFromGit } from './git.mjs';

const order = (left, right) => left.path.localeCompare(right.path, 'en') || left.startLine - right.startLine || left.column - right.column || left.ruleId.localeCompare(right.ruleId, 'en');
const lineCount = source => Math.max(1, source.split(/\r?\n/).length);
const selectedPath = (project, name) => isSourcePath(name) && !name.split('/').slice(0, -1).some(part => EXCLUDED_DIRS.has(part)) && matches(name, project.include, project.exclude);

function requestedFiles(project, values, git, diff) {
  if (values === undefined) return null;
  assert(Array.isArray(values) && values.length > 0 && values.length <= 10000, 'files must be a nonempty array of exact project-relative files');
  const selected = new Set(values.map(projectRelativeFile));
  for (const name of selected) {
    if (git?.staged && git.indexEntries.has(name)) continue;
    if (diff?.files.some(file => file.deleted && file.oldPath === name)) continue;
    let absolute = project.root;
    for (const part of name.split('/')) {
      absolute = path.join(absolute, part);
      assert(fs.existsSync(absolute), `Requested file does not exist: ${name}`);
      assert(!fs.lstatSync(absolute).isSymbolicLink(), `Requested file contains a symbolic link: ${name}`);
    }
    assert(fs.statSync(absolute).isFile(), `Requested path is not a file: ${name}`);
  }
  return selected;
}

function policyComparison(git, context, catalog, projectId) {
  const currentHash = digest(effectivePolicy(context.config, catalog, projectId));
  if (!git) return { status: 'UNAVAILABLE', reason: 'NO_GIT_COMPARISON', currentHash, errors: [] };
  const values = [], stagedValues = new Map(), policyFiles = [], errors = [];
  let unavailable = null;
  for (const [label, absolute, current] of [['config', context.absolute, context.config], ['catalog', context.catalogPath, catalog]]) {
    if (!absolute || !contained(git.root, path.resolve(absolute))) { unavailable = 'POLICY_OUTSIDE_GIT_ROOT'; continue; }
    const name = projectRelativeFile(posix(path.relative(git.root, absolute)));
    policyFiles.push(name);
    const working = git.readWorktree(name);
    try {
      if (working.error || digest(JSON.parse(working.source.replace(/^\uFEFF/, ''))) !== digest(current)) errors.push({ path: name, reason: 'POLICY_CHANGED_DURING_REVIEW', message: `Loaded ${label} no longer matches its source file.` });
    } catch (error) { errors.push({ path: name, reason: 'POLICY_CHANGED_DURING_REVIEW', message: error.message }); }
    if (git.staged && (git.indexEntries.has(name) || git.baseEntries.has(name))) {
      const index = git.readIndex(name);
      try {
        assert(!index.error && !index.missing, index.error ?? `The staged ${label} is missing`);
        stagedValues.set(label, JSON.parse(index.source.replace(/^\uFEFF/, '')));
      } catch (error) { errors.push({ path: name, reason: 'STAGED_POLICY_MISMATCH', message: error.message }); }
    }
    const prior = git.readBase(name);
    if (prior.error || prior.missing) { unavailable = prior.error ?? 'POLICY_NOT_IN_BASE_COMMIT'; continue; }
    try { values.push(JSON.parse(prior.source.replace(/^\uFEFF/, ''))); }
    catch { unavailable = 'BASE_POLICY_NOT_VALID_JSON'; }
  }
  if (git.staged && stagedValues.size) {
    try {
      const stagedConfig = stagedValues.get('config') ?? context.config, stagedCatalog = stagedValues.get('catalog') ?? catalog;
      validateCatalog({ config: stagedConfig }, stagedCatalog);
      if (digest(effectivePolicy(stagedConfig, stagedCatalog, projectId)) !== currentHash) errors.push({ reason: 'STAGED_POLICY_MISMATCH', message: 'The staged enforcement policy differs from the loaded policy; stage or restore it before reviewing staged code.' });
    } catch (error) { errors.push({ reason: 'STAGED_POLICY_MISMATCH', message: error.message }); }
  }
  if (unavailable || values.length !== 2) return { status: 'UNAVAILABLE', reason: unavailable ?? 'POLICY_HISTORY_UNAVAILABLE', currentHash, policyFiles, errors };
  try {
    const [baseConfig, baseCatalog] = values;
    validateCatalog({ config: baseConfig }, baseCatalog);
    const basePolicy = effectivePolicy(baseConfig, baseCatalog, projectId), baseHash = digest(basePolicy);
    return { status: currentHash === baseHash ? 'UNCHANGED' : 'CHANGED', currentHash, baseHash, policyFiles, errors };
  } catch (error) { return { status: 'UNAVAILABLE', reason: 'BASE_POLICY_INVALID', message: error.message, currentHash, policyFiles, errors }; }
}

function indexInventory(git, project, onlyPaths) {
  const files = [], errors = [], skipped = [];
  for (const name of [...git.indexEntries.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    if (onlyPaths && !onlyPaths.has(name)) continue;
    if (!selectedPath(project, name)) continue;
    if (files.length >= 10000) { errors.push({ path: name, reason: 'FILE_LIMIT' }); continue; }
    const source = git.readIndex(name);
    if (source.error || source.missing) errors.push({ path: name, reason: source.error ?? 'INDEX_SOURCE_MISSING' });
    else files.push(source);
  }
  return { files, errors, skipped, root: project.root };
}

function baselinePairs(diff, untracked, requested) {
  const pairs = [], current = new Set();
  for (const file of diff.files) {
    if (requested && !requested.has(file.newPath) && !requested.has(file.oldPath)) continue;
    // git rm --cached leaves a worktree file both deleted from the index and untracked.
    const pair = file.deleted && untracked.includes(file.oldPath) ? { ...file, newPath: file.oldPath, deleted: false, hunks: [] } : file;
    pairs.push(pair);
    if (pair.newPath) current.add(pair.newPath);
  }
  for (const name of untracked) if (!current.has(name) && (!requested || requested.has(name))) pairs.push({ oldPath: null, newPath: name, hunks: [] });
  return pairs;
}

export function reviewProject(context, catalog, projectId, options = {}) {
  const { diffText, untracked = [], newOnly = false } = options;
  assert(typeof newOnly === 'boolean', 'newOnly must be boolean');
  assert(Array.isArray(untracked) && untracked.every(name => typeof name === 'string'), 'untracked must be an array of project-relative paths');
  untracked.forEach(projectRelativeFile);
  validateCatalog(context, catalog);
  const started = performance.now(), project = projectInfo(context, projectId);
  const git = gitComparison(options, project.root);
  const diff = diffText === undefined ? null : parseUnifiedDiff(diffText);
  const requested = requestedFiles(project, options.files, git, diff);
  const policy = policyComparison(git, context, catalog, projectId);
  const fullReviewReason = git && (policy.status === 'CHANGED' ? 'POLICY_CHANGED' : newOnly && policy.status !== 'UNCHANGED' ? 'POLICY_HISTORY_UNAVAILABLE' : null);
  const pairs = diff ? baselinePairs(diff, untracked, requested) : [];
  const onlyPaths = fullReviewReason ? undefined : diff ? new Set(pairs.map(file => file.newPath).filter(Boolean)) : requested ?? undefined;
  const inventory = git?.staged ? indexInventory(git, project, onlyPaths) : walk(project.root, { include: project.include, exclude: project.exclude, onlyPaths });
  const errors = [...inventory.errors, ...policy.errors, ...(git?.errors ?? [])], skipped = [...inventory.skipped], manual = new Map(), suppressed = [], sources = [];
  const touched = new Map(), analyses = new Map(), ruleKinds = new Map();
  for (const message of diff?.errors ?? []) errors.push({ reason: 'INVALID_DIFF', message });
  if (newOnly && !git) errors.push({ reason: 'BASELINE_REQUIRES_GIT_SNAPSHOT', message: 'New-only review requires an in-process diffFromGit snapshot, not a supplied diff or JSON metadata.' });
  if (git && !git.verifyIndex()) errors.push({ reason: 'INDEX_CHANGED_SINCE_CAPTURE' });
  if (diff) {
    for (const file of pairs) {
      if (!file.newPath) { skipped.push({ path: file.oldPath, reason: 'DELETED_FILE_NO_POSTIMAGE' }); continue; }
      const name = file.newPath;
      if (!isSourcePath(name)) { skipped.push({ path: name, reason: 'OUTSIDE_JS_TS_COVERAGE' }); continue; }
      if (!selectedPath(project, name)) { skipped.push({ path: name, reason: 'EXCLUDED_BY_PROJECT_CONFIG' }); continue; }
      if (touched.has(name)) { errors.push({ path: name, reason: 'DUPLICATE_DIFF_FILE' }); continue; }
      const source = inventory.files.find(candidate => candidate.path === name);
      const ranges = file.metadataOnly || untracked.includes(name) ? [{ start: 1, end: source ? lineCount(source.source) : 1 }] : file.touchedRanges ?? [];
      touched.set(name, { ...file, touchedRanges: ranges });
      if (!source) { errors.push({ path: name, reason: 'DIFF_POSTIMAGE_MISSING_OR_NOT_READABLE' }); continue; }
      if (file.binary) { errors.push({ path: name, reason: 'BINARY_DIFF_UNSUPPORTED' }); continue; }
      const lines = source.source.split(/\r?\n/);
      if (ranges.some(range => range.start > lines.length || range.end > lines.length)) errors.push({ path: name, reason: 'DIFF_RANGE_OUTSIDE_POSTIMAGE' });
      if (!file.metadataOnly && !(file.newLineContent ?? []).length && !git) errors.push({ path: name, reason: 'DIFF_POSTIMAGE_UNVERIFIABLE', message: 'Deletion-only patch has no new-side/context lines. Use a fresh --base review or a diff with context.' });
      for (const content of file.newLineContent ?? []) if (lines[content.line - 1] !== content.text) { errors.push({ path: name, line: content.line, reason: 'STALE_DIFF_POSTIMAGE_MISMATCH' }); break; }
    }
  }
  const selected = diff && !fullReviewReason ? inventory.files.filter(file => touched.has(file.path)) : inventory.files;
  let parsedFiles = 0;
  const activeRuleIds = new Set(), enforceRuleIds = new Set(), candidateIds = new Set();
  for (const file of selected) {
    const captured = git?.targetSnapshots.get(file.path);
    if (captured?.error || captured?.missing) errors.push({ path: file.path, reason: captured.error ?? 'SNAPSHOT_POSTIMAGE_MISSING' });
    else if (captured && captured.hash !== file.hash) errors.push({ path: file.path, reason: 'WORKTREE_CHANGED_SINCE_CAPTURE' });
    const resolved = resolveRules(context.config, catalog, project.scope, file.path);
    for (const conflict of resolved.conflicts) errors.push({ path: file.path, reason: 'RULE_CONFLICT', ...conflict });
    for (const suppression of resolved.suppressed) suppressed.push({ path: file.path, ...suppression });
    for (const candidate of resolved.candidates) candidateIds.add(candidate.id);
    for (const rule of resolved.rules) {
      activeRuleIds.add(rule.id); ruleKinds.set(rule.id, rule);
      if (rule.mode === 'enforce' && rule.check.kind !== 'manual') enforceRuleIds.add(rule.id);
      if (rule.check.kind === 'manual') {
        const item = manual.get(rule.id) ?? { id: rule.id, title: rule.title, description: rule.description, scope: rule.scope, evidence: rule.evidence, files: [] };
        const ranges = diff && !fullReviewReason ? touched.get(file.path)?.touchedRanges ?? [] : [{ start: 1, end: lineCount(file.source) }];
        item.files.push({ path: file.path, ranges: ranges.map(range => ({ ...range })), sourceHash: file.hash });
        manual.set(rule.id, item);
      }
    }
    const analysis = analyzeSource(file.source, file.path, resolved.conflicts.length ? [] : resolved.rules);
    sources.push({ path: file.path, sha256: file.hash, ...(git ? { origin: git.metadata.target, ...(file.gitBlobOid ? { gitBlobOid: file.gitBlobOid } : {}) } : {}) });
    if (analysis.parseErrors.length) errors.push(...analysis.parseErrors.map(error => ({ path: file.path, reason: 'PARSE_ERROR', ...error })));
    else parsedFiles++;
    analyses.set(file.path, { file, analysis, rules: resolved.rules, conflicts: resolved.conflicts });
  }
  for (const skip of inventory.skipped.filter(item => item.reason === 'SYMLINK_NOT_FOLLOWED')) {
    if (!diff || fullReviewReason || [...touched.keys()].some(name => name === skip.path || name.startsWith(`${skip.path}/`))) errors.push({ path: skip.path, reason: 'SOURCE_SYMLINK_NOT_ANALYZED' });
  }
  let findings = [];
  const enrich = (finding, file, relation = diff && !fullReviewReason ? 'touches-change' : 'not-compared') => ({ ...finding, project: project.id, path: file.path, scope: project.scope, changeRelation: relation, sourceHash: file.hash });
  for (const { file, analysis } of analyses.values()) {
    const ranges = diff && !fullReviewReason ? touched.get(file.path)?.touchedRanges : null;
    for (const finding of analysis.findings) if (!ranges || ranges.some(range => finding.startLine <= range.end && finding.endLine >= range.start)) findings.push(enrich(finding, file));
  }
  let baseline;
  if (newOnly) {
    baseline = {
      status: fullReviewReason === 'POLICY_CHANGED' ? 'POLICY_CHANGED_FULL_REVIEW' : fullReviewReason === 'POLICY_HISTORY_UNAVAILABLE' ? 'POLICY_HISTORY_UNAVAILABLE' : 'COMPARED',
      baseCommit: git?.metadata.baseCommit ?? null, policyHash: policy.currentHash, newOnlyApplied: false,
      matching: 'per-file-rule-token-occurrences-v1', counts: null, newFindings: [], existingFindings: [], resolvedFindings: [], sources: [],
      limitations: ['Occurrence matching is syntactic, not proof of semantic identity. Named metric violations use their lexical owner; an increased metric is new with baselineChange=worsened. Other checks require matching tokens.', 'Only compared files are classified. A resolved finding means the selected checker no longer reports that occurrence.'],
    };
    if (!fullReviewReason && git && !errors.length) {
      for (const pair of pairs) {
        const priorApplicable = pair.oldPath && selectedPath(project, pair.oldPath);
        const target = pair.newPath ? analyses.get(pair.newPath) : null;
        if (!priorApplicable && !target) continue;
        let before = [], prior = { path: pair.oldPath, source: '', hash: null };
        if (priorApplicable) {
          prior = git.readBase(pair.oldPath);
          if (prior.error || prior.missing) { errors.push({ path: pair.oldPath, reason: prior.error ? 'BASELINE_SOURCE_UNREADABLE' : 'BASELINE_SOURCE_MISSING', message: prior.error }); continue; }
          const resolved = resolveRules(context.config, catalog, project.scope, pair.oldPath);
          for (const rule of resolved.rules) ruleKinds.set(rule.id, rule);
          if (resolved.conflicts.length) { errors.push(...resolved.conflicts.map(conflict => ({ path: pair.oldPath, reason: 'BASELINE_RULE_CONFLICT', ...conflict }))); continue; }
          const analysis = analyzeSource(prior.source, prior.path, resolved.rules);
          baseline.sources.push({ path: prior.path, sha256: prior.hash, gitBlobOid: prior.gitBlobOid });
          if (analysis.parseErrors.length) { errors.push(...analysis.parseErrors.map(error => ({ path: prior.path, reason: 'BASELINE_PARSE_ERROR', ...error }))); continue; }
          before = analysis.findings.map(finding => enrich(finding, prior, 'base-commit'));
        }
        const after = target ? target.analysis.findings.map(finding => enrich(finding, target.file, 'compared-to-base')) : [];
        const compared = compareFindings(before, after, { oldSource: prior.source, newSource: target?.file.source ?? '', rules: [...ruleKinds.values()], hunks: pair.hunks ?? [] });
        baseline.newFindings.push(...compared.newFindings);
        baseline.existingFindings.push(...compared.existingFindings);
        baseline.resolvedFindings.push(...compared.resolvedFindings);
      }
      findings = baseline.newFindings;
    }
  }
  if (git) {
    if (!git.verifyIndex()) errors.push({ reason: 'INDEX_CHANGED_DURING_REVIEW' });
    if (!git.staged) {
      if (!git.verifyWorktree()) errors.push({ reason: 'WORKTREE_CHANGED_DURING_REVIEW' });
      for (const file of selected) {
        const latest = git.readWorktree(file.path);
        if (latest.error || latest.hash !== file.hash) errors.push({ path: file.path, reason: 'WORKTREE_CHANGED_DURING_REVIEW', message: latest.error });
      }
    }
  }
  if (baseline) {
    for (const key of ['newFindings', 'existingFindings', 'resolvedFindings']) baseline[key].sort(order);
    if (errors.length) baseline.status = 'INCOMPLETE';
    else if (!fullReviewReason) {
      baseline.newOnlyApplied = true;
      baseline.counts = { new: baseline.newFindings.length, existing: baseline.existingFindings.length, resolved: baseline.resolvedFindings.length };
    }
  }
  findings.sort(order);
  const blocking = findings.filter(finding => finding.mode === 'enforce' && finding.severity === 'error').length;
  const emptyDiff = diff && !fullReviewReason && diff.files.length === 0 && untracked.length === 0;
  const notApplicable = !selected.length && !emptyDiff && !fullReviewReason && Boolean(diff || requested);
  if (!selected.length && !emptyDiff && !notApplicable) errors.push({ reason: 'NO_ANALYZABLE_FILES', message: 'No selected JS/TS files in a full review; this is not a passed review.' });
  const status = errors.length ? 'INCOMPLETE' : blocking ? 'VIOLATIONS' : emptyDiff ? 'NO_CHANGES' : notApplicable ? 'NOT_APPLICABLE' : manual.size ? 'MANUAL_REVIEW_REQUIRED' : !enforceRuleIds.size ? 'ADVISORY_ONLY' : 'CHECKS_PASSED';
  return {
    schemaVersion: 1, tool: { name: 'SelfReview', version: VERSION }, project: project.id, scope: project.scope,
    status, exitCode: errors.length ? 2 : blocking ? 1 : 0, authority: 'STATIC_SYNTAX_ONLY',
    resultScope: fullReviewReason ? 'full-project-policy-review' : baseline?.newOnlyApplied ? 'changed-files-baseline' : diff ? 'changed-node-ranges' : 'selected-files',
    selection: fullReviewReason || (!diff && !requested) ? { mode: 'project' } : diff ? { mode: 'diff', paths: [...new Set(pairs.flatMap(file => [file.oldPath, file.newPath]).filter(Boolean))].sort() } : { mode: 'files', paths: [...requested].sort() },
    diffCorrelation: diff ? git ? 'LOCAL_GIT_DIFF' : 'SUPPLIED_NEW_SIDE_LINES_ONLY' : null,
    ...(git ? { git: git.metadata, policyComparison: { ...policy, errors: undefined }, fullReviewReason } : {}),
    ...(baseline ? { baseline } : {}),
    configHash: context.hash, catalogHash: digest(catalog), generatedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
    coverage: { discoveredFiles: inventory.files.length, selectedFiles: selected.length, parsedFiles, activeRules: activeRuleIds.size, enforcedAstRules: enforceRuleIds.size, candidateRulesNotEnforced: candidateIds.size, manualRules: manual.size, skippedFiles: skipped.length, fullProjectTypeCheck: false, runtimeTests: false },
    findings, errors, skipped, suppressed, manualChecklist: [...manual.values()], sources,
    limitations: ['Only configured JS/TS syntax checks are evaluated; no proof of architecture, business logic, type safety or runtime correctness.', baseline?.newOnlyApplied ? 'New/existing attribution uses occurrence matching under the same current policy; it is not semantic equivalence.' : 'Changed-node findings may predate this change; use an eligible Git new-only comparison for occurrence attribution.', 'Natural-language conventions require an agent or human review; candidate rules are not enforced.'],
    warnings: diff?.warnings ?? [],
  };
}

export function renderReport(report) {
  const lines = [`SelfReview ${VERSION} | ${report.project} | scope: ${report.scope}`, `${report.status} | exit ${report.exitCode} | ${report.authority}`,
    `Files: ${report.coverage.parsedFiles}/${report.coverage.selectedFiles} parsed; enforced AST rules: ${report.coverage.enforcedAstRules}; candidates: ${report.coverage.candidateRulesNotEnforced}; manual: ${report.coverage.manualRules}`];
  if (report.git) lines.push(`Git: ${report.git.baseMode} ${report.git.requestedBase} -> ${report.git.baseCommit}; target: ${report.git.target}`);
  if (report.fullReviewReason) lines.push(`Full project review: ${report.fullReviewReason}; new-only gating is not applied.`);
  if (report.baseline?.counts) lines.push(`Baseline: ${report.baseline.counts.new} new, ${report.baseline.counts.existing} existing, ${report.baseline.counts.resolved} resolved; occurrence matching, not semantic proof.`);
  for (const finding of report.findings.filter(item => item.mode !== 'advisory')) lines.push(`${finding.severity.toUpperCase()} ${finding.path}:${finding.startLine}:${finding.column} [${finding.ruleId}] ${finding.message}`);
  const adviceGroups = new Map();
  for (const finding of report.findings.filter(item => item.mode === 'advisory')) { const group = adviceGroups.get(finding.ruleId) ?? []; group.push(finding); adviceGroups.set(finding.ruleId, group); }
  for (const [ruleId, group] of adviceGroups) {
    lines.push(`ADVICE [${ruleId}] ${group.length} occurrence(s) in ${new Set(group.map(finding => finding.path)).size} file(s).`);
    for (const finding of group.slice(0, 3)) lines.push(`  ${finding.path}:${finding.startLine}:${finding.column} ${finding.message}`);
    if (group.length > 3) lines.push(`  ${group.length - 3} additional occurrence(s); all findings are retained by --format json.`);
  }
  for (const error of report.errors) lines.push(`INCOMPLETE ${error.path ?? ''} ${error.reason}: ${error.message ?? error.family ?? ''}`);
  for (const item of report.manualChecklist) {
    lines.push(`MANUAL [${item.id}] ${item.title}`);
    for (const file of item.files ?? []) lines.push(`  ${file.path}: ${file.ranges.map(range => `${range.start}-${range.end}`).join(', ')}`);
  }
  if (report.status === 'NOT_APPLICABLE') lines.push('No applicable JS/TS postimages in this selection; no code checks were claimed.');
  else if (!report.findings.length) lines.push('No findings from the evaluated checks. This is not a guarantee of overall code quality.');
  if (report.resultScope === 'changed-node-ranges') lines.push('Diff mode: findings touch changed nodes; they are not proven newly introduced.');
  lines.push('Coverage: JS/TS syntax only. Build, types, tests, runtime and semantic review remain separate.');
  return lines.join('\n') + '\n';
}
