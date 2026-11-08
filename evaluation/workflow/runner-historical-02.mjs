import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { ESLint } from 'eslint';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
};
const sortedTuples = tuples => tuples.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const enforced = report => report.findings.filter(finding => finding.mode === 'enforce');
const ownSnapshot = value => JSON.stringify(value);
const unavailable = (reason, details = {}) => ({ available: false, reason, observed: {}, details });

function registeredCases() {
  const registration = readJson(path.join(here, 'preregistered.json'));
  for (const entry of registration.files) {
    const actual = sha256(fs.readFileSync(path.join(here, entry.path)));
    if (actual !== entry.sha256) throw new Error('Preregistered file changed: ' + entry.path);
  }
  const specification = readJson(path.join(here, 'cases.json'));
  if (registration.caseCount !== specification.cases.length) throw new Error('Preregistered case count changed');
  const amendmentRegistration = readJson(path.join(here, 'preregistered-amendment-01.json'));
  if (sha256(fs.readFileSync(path.join(here, 'preregistered.json'))) !== amendmentRegistration.originalRegistrationSha256) throw new Error('Original registration changed');
  for (const entry of amendmentRegistration.files) {
    if (sha256(fs.readFileSync(path.join(here, entry.path))) !== entry.sha256) throw new Error('Registered amendment changed: ' + entry.path);
  }
  const amendment = readJson(path.join(here, 'amendments/001-sparse-sample.json'));
  if (sha256(fs.readFileSync(path.join(here, 'cases.json'))) !== amendment.originalCasesSha256) throw new Error('Amendment targets a different case version');
  return { specification, registration, amendment, amendmentRegistration };
}

function implementationFiles(root) {
  const entries = [];
  for (const name of ['package.json', 'src', 'bin']) {
    const absolute = path.join(root, name);
    if (!fs.existsSync(absolute)) continue;
    const visit = (filename, relative) => {
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink()) throw new Error('Implementation snapshot contains a symlink: ' + relative);
      if (info.isDirectory()) {
        for (const child of fs.readdirSync(filename).sort()) visit(path.join(filename, child), relative + '/' + child);
      } else if (info.isFile()) {
        const bytes = fs.readFileSync(filename);
        entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    };
    visit(absolute, name);
  }
  return entries;
}

function createFixture(directory, api, specification, options = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const gitRoot = options.git ? path.join(directory, 'project') : null;
  const settings = options.git ? gitRoot : path.join(directory, 'settings');
  fs.mkdirSync(settings, { recursive: true });
  const definitions = options.projects ?? [{ id: 'app', scope: 'team' }];
  const projects = definitions.map(project => ({
    ...project,
    root: options.git ? '.' : '../projects/' + project.id,
    include: ['**/*.js'],
  }));
  const roots = new Map();
  for (const project of projects) {
    const root = path.resolve(settings, project.root);
    roots.set(project.id, root);
    fs.mkdirSync(root, { recursive: true });
  }
  const configPath = path.join(settings, 'selfreview.config.json');
  const catalogPath = path.join(settings, '.selfreview', 'catalog.json');
  writeJson(configPath, {
    schemaVersion: 1,
    catalog: '.selfreview/catalog.json',
    bestPractices: false,
    scopes: options.scopes ?? [{ id: 'team' }],
    projects,
  });
  writeJson(catalogPath, { schemaVersion: 1, rules: options.rules ?? [] });
  const open = () => api.loadConfig(configPath);
  const catalog = () => api.loadCatalog(open());
  const source = (project, relative, text) => {
    const filename = path.join(roots.get(project), relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);
    return filename;
  };
  const review = (project = 'app', reviewOptions = {}) => {
    const context = open();
    return api.reviewProject(context, api.loadCatalog(context), project, reviewOptions);
  };
  const saveCatalog = value => writeJson(catalogPath, value);
  const approve = (kind = 'no-var') => {
    const value = catalog();
    const matching = value.rules.filter(rule => rule.check.kind === kind);
    if (matching.length !== 1) throw new Error('Expected exactly one rule to approve, observed ' + matching.length);
    const index = value.rules.findIndex(rule => rule.id === matching[0].id);
    value.rules[index] = api.approveRule(matching[0], 'Workflow fixture reviewer', 'Explicit approval in a synthetic acceptance fixture.', specification.frozenApprovalDate);
    saveCatalog(value);
    return value.rules[index];
  };
  return { directory, settings, configPath, catalogPath, roots, open, catalog, source, review, saveCatalog, approve };
}

function declaredRule(api, specification, { id, scope, kind, options = {} }) {
  const description = 'Declared synthetic workflow policy: ' + id;
  return api.approveRule({
    id, family: kind, scope, title: description, description,
    status: 'candidate', mode: 'enforce', severity: 'error',
    check: { kind, options },
    applicability: { include: ['src/**/*.js'], exclude: [] },
    evidence: [{ kind: 'document', path: 'synthetic:workflow/cases.json', sha256: sha256(description), excerpt: description }],
  }, 'Workflow fixture reviewer', 'Explicit fixture policy, not inferred from observed code.', specification.frozenApprovalDate);
}

function assertComplete(report) {
  if (report.errors?.length || report.exitCode === 2) {
    const error = new Error('Unexpected incomplete fixture review');
    error.diagnostics = report;
    throw error;
  }
}

function importDocument(fixture, api, text, filename = 'agreements.md') {
  const document = path.join(fixture.directory, filename);
  fs.writeFileSync(document, text);
  return { document, report: api.learnScope(fixture.open(), 'team', { docs: [document], code: false }) };
}

function ruleIntegrity(api, before, after) {
  let valid = true;
  try { api.validateRule(after); } catch { valid = false; }
  return {
    originalRuleIdPreserved: after?.id === before.id,
    originalApprovedSnapshotUnchanged: ownSnapshot(after) === ownSnapshot(before),
    approvalStillValid: valid && after?.status === 'approved',
  };
}

function gitFixture(fixture) {
  const root = fixture.roots.get('app');
  const hooks = path.join(fixture.directory, 'empty-hooks');
  const globalConfig = path.join(fixture.directory, 'empty-gitconfig');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'SelfReview acceptance',
    GIT_AUTHOR_EMAIL: 'workflow@example.invalid',
    GIT_COMMITTER_NAME: 'SelfReview acceptance',
    GIT_COMMITTER_EMAIL: 'workflow@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-08T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-08T00:00:00Z',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git = args => execFileSync('git', [
    '-c', 'core.hooksPath=' + hooks, '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args,
  ], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  git(['init', '--quiet']);
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'Fixed acceptance baseline']);
  return { root, commit: git(['rev-parse', 'HEAD']).trim() };
}

async function scopedSyntax(directory, api, specification) {
  const policies = [
    { id: 'a.console', scope: 'scope-a', kind: 'no-console', options: { allowMethods: ['warn'] } },
    { id: 'bcd.variables', scope: 'scope-bcd', kind: 'no-var' },
    { id: 'e.equality', scope: 'scope-e', kind: 'strict-equality', options: { allowNull: true } },
  ];
  const f = createFixture(directory, api, specification, {
    scopes: ['scope-a', 'scope-bcd', 'scope-e'].map(id => ({ id })),
    projects: [{ id: 'a', scope: 'scope-a' }, ...['b', 'c', 'd'].map(id => ({ id, scope: 'scope-bcd' })), { id: 'e', scope: 'scope-e' }],
    rules: policies.map(policy => declaredRule(api, specification, policy)),
  });
  const core = [], eslint = [], reports = [];
  for (const project of ['a', 'b', 'c', 'd', 'e']) {
    for (const [relative, text] of Object.entries(specification.fixtures.scopedSources)) f.source(project, relative, text);
    const report = f.review(project);
    assertComplete(report);
    reports.push({ project, status: report.status, errors: report.errors, findings: report.findings });
    for (const finding of enforced(report)) {
      core.push([project, finding.path, policies.find(policy => policy.id === finding.ruleId).kind, finding.startLine]);
    }
    const nativeRules = project === 'a'
      ? { 'no-console': ['error', { allow: ['warn'] }] }
      : project === 'e' ? { eqeqeq: ['error', 'always', { null: 'ignore' }] } : { 'no-var': 'error' };
    const linter = new ESLint({
      cwd: f.roots.get(project), overrideConfigFile: true,
      overrideConfig: [{ files: ['src/**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { console: 'readonly' } }, rules: nativeRules }],
    });
    for (const [relative, text] of Object.entries(specification.fixtures.scopedSources)) {
      const [result] = await linter.lintText(text, { filePath: path.join(f.roots.get(project), relative) });
      for (const message of result.messages) {
        if (message.fatal) throw new Error('ESLint comparator could not parse fixture: ' + message.message);
        if (!message.ruleId) continue;
        eslint.push([project, relative, message.ruleId === 'eqeqeq' ? 'strict-equality' : message.ruleId, message.line]);
      }
    }
  }
  sortedTuples(core); sortedTuples(eslint);
  return {
    observed: { findings: core, eslintFindingsMatch: isDeepStrictEqual(core, eslint), negativeFixtureFindings: core.filter(tuple => tuple[1] !== 'src/main.js').length },
    details: { selfreview: reports, eslintFindings: eslint, comparator: 'ESLint equivalent rules only; locations compared by line, not wording or columns.' },
  };
}

async function executeCase(item, directory, api, specification) {
  const data = specification.fixtures;
  if (item.driver === 'scopedSyntax') return scopedSyntax(directory, api, specification);
  const sampling = ['sampledSubset', 'sparseProject'].includes(item.driver);
  const baseline = item.family === 'baseline';
  const f = createFixture(directory, api, specification, {
    git: baseline,
    ...(sampling ? { projects: [{ id: 'large', scope: 'team' }, { id: 'small', scope: 'team' }] } : {}),
    ...(baseline ? { rules: [declaredRule(api, specification, { id: 'team.console', scope: 'team', kind: 'no-console' })] } : {}),
  });

  if (item.driver === 'candidateOnly') {
    f.source('app', 'src/main.js', data.minimalSource);
    const imported = importDocument(f, api, data.initialDocument).report;
    const catalog = f.catalog(), report = f.review();
    assertComplete(report);
    return { observed: { logicalNoVarRules: catalog.rules.filter(rule => rule.check.kind === 'no-var').length, approvedRules: catalog.rules.filter(rule => rule.status === 'approved').length, enforcedFindings: enforced(report).length, approvedAutomatically: imported.coverage.approvedAutomatically }, details: { imported, report, catalog } };
  }

  if (item.driver === 'repeatedMr') {
    f.source('app', 'src/main.js', data.minimalSource);
    const first = path.join(directory, 'first-mr.json'), second = path.join(directory, 'second-mr.json');
    writeJson(first, data.firstMr); writeJson(second, data.secondMr);
    const initialImport = api.learnScope(f.open(), 'team', { mrs: [first], code: false });
    const original = f.approve();
    const secondImport = api.learnScope(f.open(), 'team', { mrs: [second], code: false });
    const catalog = f.catalog(), after = catalog.rules.find(rule => rule.id === original.id);
    const logical = catalog.lifecycle?.rules?.find(rule => rule.ruleId === original.id);
    const evidence = logical?.evidence ?? catalog.rules.filter(rule => rule.check.kind === 'no-var').flatMap(rule => rule.evidence);
    return { observed: { logicalNoVarRules: catalog.rules.filter(rule => rule.check.kind === 'no-var').length, ...ruleIntegrity(api, original, after), evidenceSources: new Set(evidence.map(entry => entry.path)).size }, details: { initialImport, secondImport, catalog } };
  }

  if (['unrelatedDocumentEdit', 'sourceChanged', 'sourceMissing'].includes(item.driver)) {
    f.source('app', 'src/main.js', data.minimalSource);
    const { document, report: initialImport } = importDocument(f, api, data.initialDocument);
    const original = f.approve();
    if (item.driver === 'unrelatedDocumentEdit') {
      fs.writeFileSync(document, data.editedDocument);
      const nextImport = api.learnScope(f.open(), 'team', { docs: [document], code: false });
      const catalog = f.catalog(), after = catalog.rules.find(rule => rule.id === original.id);
      return { observed: { logicalNoVarRules: catalog.rules.filter(rule => rule.check.kind === 'no-var').length, ...ruleIntegrity(api, original, after) }, details: { initialImport, nextImport, catalog } };
    }
    if (typeof api.sourceStatus !== 'function') return unavailable('No sourceStatus API in this implementation', { initialImport });
    if (item.driver === 'sourceMissing') fs.unlinkSync(document); else fs.writeFileSync(document, data.changedDocument);
    const catalogBefore = fs.readFileSync(f.catalogPath), configBefore = fs.readFileSync(f.configPath);
    const sourceBefore = fs.existsSync(document) ? fs.readFileSync(document) : null;
    const catalog = f.catalog(), catalogSnapshot = ownSnapshot(catalog);
    const status = api.sourceStatus(f.open(), catalog, { scope: 'team' });
    const unchanged = fs.readFileSync(f.catalogPath).equals(catalogBefore) && fs.readFileSync(f.configPath).equals(configBefore)
      && ownSnapshot(catalog) === catalogSnapshot
      && (sourceBefore === null ? !fs.existsSync(document) : fs.readFileSync(document).equals(sourceBefore));
    return {
      observed: {
        sourceStates: status.sources.map(source => source.state).sort(),
        originalApprovedSnapshotUnchanged: ownSnapshot(catalog.rules.find(rule => rule.id === original.id)) === ownSnapshot(original),
        readOnly: status.readOnly === true && unchanged,
      },
      details: { sourceStatus: status, catalog },
    };
  }

  if (item.driver === 'manualDistinct') {
    const imported = importDocument(f, api, data.manualDocument).report;
    const catalog = f.catalog(), manual = catalog.rules.filter(rule => rule.check.kind === 'manual');
    return { observed: { manualRules: manual.length, uniqueRuleIds: new Set(manual.map(rule => rule.id)).size, approvedRules: catalog.rules.filter(rule => rule.status === 'approved').length }, details: { imported, catalog } };
  }

  if (sampling) {
    f.source('large', 'src/main.js', data.modernSample);
    f.source('small', 'src/main.js', data.sparseLegacySample);
    const imported = api.learnScope(f.open(), 'team', {
      minSamples: specification.settings.minSamples,
      threshold: specification.settings.threshold,
      ...(item.driver === 'sampledSubset' ? { codePaths: [f.roots.get('large')] } : {}),
    });
    const proposal = imported.proposalCoverage?.find(candidate => candidate.check.kind === 'no-var');
    if (!proposal) return unavailable('No per-proposal project support states in this implementation', { imported, catalog: f.catalog() });
    return { observed: { projects: Object.fromEntries(proposal.projects.map(project => [project.project, project.status])), approvedRules: f.catalog().rules.filter(rule => rule.status === 'approved').length }, details: { imported, catalog: f.catalog() } };
  }

  if (item.driver === 'docsOnlyDiff') {
    f.source('app', 'src/main.js', data.minimalSource);
    f.source('app', 'README.md', 'Updated documentation.\n');
    const report = f.review('app', { diffText: data.docsDiff });
    return { observed: { status: report.status, exitCode: report.exitCode, selectedFiles: report.coverage.selectedFiles }, details: { report } };
  }

  if (item.driver === 'invalidCurrentSource') {
    f.source('app', 'src/main.js', data.invalidSource);
    const report = f.review('app', { diffText: data.invalidSourceDiff });
    return { observed: { status: report.status, exitCode: report.exitCode, hasParseError: report.errors.some(error => error.reason === 'PARSE_ERROR') }, details: { report } };
  }

  if (baseline) {
    const originalSource = item.driver === 'baselineInvalid' ? data.baselineInvalid : item.driver === 'baselinePolicyChanged' ? data.baselinePolicySource : data.baselineOriginal;
    f.source('app', 'src/main.js', originalSource);
    const git = gitFixture(f);
    if (item.driver === 'baselinePolicyChanged') {
      const catalog = f.catalog();
      const current = catalog.rules[0];
      current.check.options.allowMethods = ['warn'];
      catalog.rules[0] = api.approveRule(current, 'Workflow fixture reviewer', 'Explicit policy change in the acceptance case.', specification.frozenApprovalDate);
      f.saveCatalog(catalog);
    } else {
      const source = item.driver === 'baselineInvalid' ? data.baselineResolved : data[item.driver];
      f.source('app', 'src/main.js', source);
    }
    const selection = api.diffFromGit(git.root, git.commit);
    const report = f.review('app', { ...selection, newOnly: true });
    if (!report.baseline) return unavailable('No baseline comparison report in this implementation', { report, baseCommit: git.commit });
    return { observed: { status: report.status, baselineStatus: report.baseline.status, counts: report.baseline.counts, enforcedFindings: enforced(report).length, exitCode: report.exitCode }, details: { report, baseCommit: git.commit } };
  }

  throw new Error('Unknown preregistered case driver: ' + item.driver);
}

function scrub(value, temporary) {
  if (typeof value === 'string') {
    return value.split(temporary).join('<fixture>').split(temporary.replaceAll('\\', '/')).join('<fixture>');
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, temporary));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, temporary)]));
  return value;
}

/** Run the frozen cases without writing results or modifying source under test. */
export async function runWorkflow({ implementationRoot = repositoryRoot, label = 'current', reference = 'working tree' } = {}) {
  const { specification, registration, amendment, amendmentRegistration } = registeredCases();
  const initialManifest = implementationFiles(implementationRoot);
  const api = { ...await import(pathToFileURL(path.join(implementationRoot, 'src/index.mjs')).href) };
  const lifecycleFile = path.join(implementationRoot, 'src/lifecycle.mjs');
  if (fs.existsSync(lifecycleFile)) Object.assign(api, await import(pathToFileURL(lifecycleFile).href));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreview-workflow-'));
  const outcomes = [];
  const started = performance.now();
  try {
    for (const item of specification.cases) {
      try {
        const caseSpecification = { ...specification, fixtures: { ...specification.fixtures, ...(amendment.caseOverrides[item.id]?.fixtures ?? {}) } };
        const execution = await executeCase(item, path.join(temporary, item.id), api, caseSpecification);
        const mismatches = execution.available === false ? [] : Object.entries(item.expect)
          .filter(([key, expected]) => !isDeepStrictEqual(execution.observed[key], expected))
          .map(([key, expected]) => ({ field: key, expected, observed: execution.observed[key] ?? null }));
        outcomes.push(scrub({
          id: item.id, family: item.family,
          outcome: execution.available === false ? 'NOT_AVAILABLE' : mismatches.length ? 'FAIL' : 'PASS',
          expected: item.expect, ...execution, mismatches,
        }, temporary));
      } catch (error) {
        outcomes.push(scrub({
          id: item.id, family: item.family, outcome: 'ERROR', expected: item.expect,
          error: { name: error.name, message: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) },
        }, temporary));
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  const currentManifest = implementationFiles(implementationRoot);
  const stable = isDeepStrictEqual(initialManifest, currentManifest);
  const counts = { total: outcomes.length, passed: 0, failed: 0, notAvailable: 0, errors: 0 };
  for (const outcome of outcomes) counts[{ PASS: 'passed', FAIL: 'failed', NOT_AVAILABLE: 'notAvailable', ERROR: 'errors' }[outcome.outcome]]++;
  const byFamily = {};
  for (const outcome of outcomes) {
    const family = byFamily[outcome.family] ??= { total: 0, passed: 0, failed: 0, notAvailable: 0, errors: 0 };
    family.total++;
    family[{ PASS: 'passed', FAIL: 'failed', NOT_AVAILABLE: 'notAvailable', ERROR: 'errors' }[outcome.outcome]]++;
  }
  return {
    schemaVersion: 1, label, createdAt: new Date().toISOString(),
    status: !stable ? 'INVALID_RUN_SOURCE_CHANGED' : counts.passed === counts.total ? 'ALL_DECLARED_CASES_MET' : 'ACCEPTANCE_GAPS',
    preregistration: registration,
    appliedAmendment: { id: amendment.id, registration: amendmentRegistration },
    implementation: { reference, stableDuringRun: stable, files: initialManifest, ...(stable ? {} : { finalFiles: currentManifest }) },
    runner: { path: 'evaluation/workflow/run.mjs', sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))) },
    environment: { node: process.version, platform: process.platform, arch: process.arch, eslint: ESLint.version },
    diagnosticElapsedMs: Math.round(performance.now() - started),
    timingInterpretation: 'Diagnostic elapsed time only; no performance or time-savings benchmark was performed.',
    measurementsNotPerformed: Object.fromEntries(specification.measurementsNotPerformed.map(name => [name, 'NOT_MEASURED'])),
    counts, byFamily, cases: outcomes,
  };
}

function historicalSnapshot(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Historical reference must be a full commit SHA');
  const scratchParent = path.join(repositoryRoot, '.selfreview');
  fs.mkdirSync(scratchParent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(scratchParent, 'workflow-history-'));
  try {
    const gitOptions = { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 };
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src', 'bin', 'package.json'], { ...gitOptions, encoding: 'utf8' }).trim().split('\n');
    for (const name of names) {
      if (!/^(?:src\/[^/]+\.mjs|bin\/[^/]+\.mjs|package\.json)$/.test(name)) throw new Error('Unexpected historical implementation path: ' + name);
      const target = path.join(temporary, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, execFileSync('git', ['show', commit + ':' + name], gitOptions));
    }
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw error;
  }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--out', '--historical', '--label'].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error('Use --out NEW_FILE [--historical FULL_COMMIT_SHA] [--label LABEL]');
    options[key] = value;
  }
  if (!options['--out']) throw new Error('--out is required; recorded results are never overwritten');
  const output = path.resolve(options['--out']);
  if (fs.existsSync(output)) throw new Error('Result file already exists: ' + output);
  let implementationRoot = repositoryRoot;
  try {
    if (options['--historical']) implementationRoot = historicalSnapshot(options['--historical']);
    const result = await runWorkflow({
      implementationRoot,
      label: options['--label'] ?? (options['--historical'] ? 'historical' : 'current'),
      reference: options['--historical'] ?? 'working tree',
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, counts: result.counts, byFamily: result.byFamily, result: output }, null, 2));
    process.exitCode = result.status === 'ALL_DECLARED_CASES_MET' ? 0 : 2;
  } finally {
    if (implementationRoot !== repositoryRoot) fs.rmSync(implementationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 2;
  });
}

