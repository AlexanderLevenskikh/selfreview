import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, loadCatalog } from '../src/config.mjs';
import { approveRule } from '../src/rules.mjs';
import { diffFromGit, reviewProject } from '../src/review.mjs';
import { gitComparison } from '../src/git.mjs';
import { sha256, writeJson } from '../src/util.mjs';

function approved(kind = 'no-console', options = {}, extra = {}) {
  return approveRule({
    id: `team.${kind}`, family: kind, title: kind, description: `Synthetic ${kind} policy`, scope: 'team',
    status: 'candidate', severity: 'error', mode: 'enforce', check: { kind, options },
    evidence: [{ kind: 'document', path: 'agreements.md', sha256: sha256('Synthetic agreement') }], ...extra,
  }, 'Synthetic reviewer', 'Workflow regression fixture', '2026-11-08T00:00:00.000Z');
}

function fixture(t, { files = { 'src/main.js': 'console.log("old");\n' }, rules = [approved()], git = true, externalPolicy = false, trackPolicy = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreview-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const policyRoot = externalPolicy ? path.join(directory, 'policy') : root;
  const configPath = path.join(policyRoot, 'selfreview.config.json'), catalogPath = path.join(policyRoot, 'catalog.json');
  const config = { schemaVersion: 1, catalog: 'catalog.json', bestPractices: false, scopes: [{ id: 'team' }], projects: [{ id: 'app', root: externalPolicy ? '../repo' : '.', scope: 'team', include: ['src/**/*.js', 'src/**/*.ts'] }] };
  const write = (name, source) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source); };
  for (const [name, source] of Object.entries(files)) write(name, source);
  writeJson(configPath, config); writeJson(catalogPath, { schemaVersion: 1, rules });
  const hooks = path.join(directory, 'empty-hooks'), emptyConfig = path.join(directory, 'empty-gitconfig');
  fs.mkdirSync(hooks); fs.writeFileSync(emptyConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'SelfReview fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'SelfReview fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const runGit = args => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git) {
    runGit(['init', '--quiet']);
    if (trackPolicy) runGit(['add', '.']);
    else for (const name of Object.keys(files)) runGit(['add', '--', name]);
    runGit(['commit', '--quiet', '-m', 'Synthetic baseline']);
  }
  const open = () => { const context = loadConfig(configPath); return { context, catalog: loadCatalog(context) }; };
  const review = options => { const { context, catalog } = open(); return reviewProject(context, catalog, 'app', options); };
  const compare = ({ base = 'HEAD', mergeBase = false, staged = false, ...options } = {}) => review({ ...diffFromGit(root, base, { mergeBase, staged }), ...options });
  return { directory, root, configPath, catalogPath, config, write, git: runGit, open, review, compare };
}

test('missing promisor blobs fail locally without invoking the fetch helper', t => {
  const f = fixture(t);
  const marker = path.join(f.directory, 'fetch-invoked');
  const helper = path.join(f.directory, 'local-upload-pack.cjs');
  const remote = path.join(f.directory, 'local-remote');
  fs.mkdirSync(remote);
  // This synthetic upload-pack only writes a marker and fails; it cannot connect anywhere.
  fs.writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.exit(1);\n`);
  const shellQuote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  f.git(['config', 'remote.origin.url', remote]);
  f.git(['config', 'remote.origin.promisor', 'true']);
  f.git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  f.git(['config', 'remote.origin.uploadpack', `${shellQuote(process.execPath)} ${shellQuote(helper)}`]);
  const oid = f.git(['rev-parse', 'HEAD:src/main.js']).trim();
  f.write('src/main.js', 'console.log("changed");\n');
  const options = diffFromGit(f.root, 'HEAD');
  const snapshot = gitComparison(options, f.root);
  const blob = path.join(f.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  fs.chmodSync(blob, 0o600);
  fs.unlinkSync(blob);
  const missing = snapshot.readBase('src/main.js');
  assert.match(missing.error, /^GIT_BLOB_READ_ERROR:/);
  assert.equal(missing.source, undefined);
  assert.equal(fs.existsSync(marker), false, 'baseline blob reads must not start a fetch');
  assert.throws(() => diffFromGit(f.root, 'HEAD'));
  assert.equal(fs.existsSync(marker), false, 'diff creation must not start a fetch either');
  // Positive control: an ordinary unguarded read really tries this entirely local helper.
  assert.throws(() => f.git(['cat-file', '-e', oid]));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'invoked');
});

test('docs-only and excluded changes are NOT_APPLICABLE while empty full scans remain incomplete', t => {
  const f = fixture(t, { git: false, files: { 'README.md': 'new\n' } });
  const docs = f.review({ diffText: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n' });
  assert.equal(docs.status, 'NOT_APPLICABLE'); assert.equal(docs.exitCode, 0); assert.equal(docs.coverage.parsedFiles, 0);
  assert.equal(f.review({ diffText: '' }).status, 'NO_CHANGES');
  const full = f.review(); assert.equal(full.status, 'INCOMPLETE'); assert.equal(full.exitCode, 2);
  assert.ok(full.errors.some(error => error.reason === 'NO_ANALYZABLE_FILES'));
  const broken = f.review({ diffText: '--- a/README.md\n+++ b/README.md\n@@ -1,2 +1 @@\n-old\n+new\n' });
  assert.equal(broken.status, 'INCOMPLETE'); assert.equal(broken.exitCode, 2);
  f.write('excluded.js', 'not valid source !');
  assert.equal(f.review({ diffText: '--- a/excluded.js\n+++ b/excluded.js\n@@ -1 +1 @@\n-old\n+not valid source !\n' }).status, 'NOT_APPLICABLE');
});

test('exact files and manual checklists retain applicability and reject path escape', t => {
  const manual = approved('manual', {}, { id: 'team.manual', family: 'responsibility', applicability: { include: ['src/a.js'] } });
  const f = fixture(t, { git: false, rules: [manual], files: { 'src/a.js': 'const a = 1;\nconst b = 3;\n', 'src/b.js': 'const b = 2;\n', 'README.md': 'notes\n' } });
  const selected = f.review({ files: ['src/a.js'] });
  assert.deepEqual(selected.sources.map(source => source.path), ['src/a.js']);
  assert.deepEqual(selected.selection, { mode: 'files', paths: ['src/a.js'] });
  assert.equal(selected.status, 'MANUAL_REVIEW_REQUIRED');
  assert.deepEqual(selected.manualChecklist[0].files, [{ path: 'src/a.js', ranges: [{ start: 1, end: 3 }], sourceHash: sha256('const a = 1;\nconst b = 3;\n') }]);
  assert.equal(f.review({ files: ['src/b.js'] }).manualChecklist.length, 0);
  assert.equal(f.review({ files: ['README.md'] }).status, 'NOT_APPLICABLE');
  const diff = f.review({ diffText: '--- a/src/a.js\n+++ b/src/a.js\n@@ -2 +2 @@\n-const b = 2;\n+const b = 3;\n' });
  assert.deepEqual(diff.manualChecklist[0].files[0].ranges, [{ start: 2, end: 2 }]);
  for (const files of [[], ['../escape.js'], [f.root], ['src/missing.js']]) assert.throws(() => f.review({ files }));
});

test('deleting the final source is applicable to baseline resolution, not an incomplete postimage', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'src/main.js'));
  assert.equal(f.compare().status, 'NOT_APPLICABLE');
  const report = f.compare({ newOnly: true });
  assert.equal(report.status, 'NOT_APPLICABLE'); assert.equal(report.exitCode, 0);
  assert.deepEqual(report.baseline.counts, { new: 0, existing: 0, resolved: 1 });
  assert.equal(report.baseline.resolvedFindings[0].path, 'src/main.js');
});

test('new-only keeps a moved/reformatted occurrence and counts added identical occurrences separately', t => {
  const f = fixture(t, { files: { 'src/main.js': 'console.log("old"); // retained\n' } });
  f.write('src/main.js', '// heading\n  console.log(\'old\'); // retained\n');
  const moved = f.compare({ newOnly: true });
  assert.equal(moved.exitCode, 0); assert.equal(moved.baseline.status, 'COMPARED');
  assert.deepEqual(moved.baseline.counts, { new: 0, existing: 1, resolved: 0 });
  assert.equal(moved.findings.length, 0);
  f.write('src/main.js', 'console.log("old");\nconsole.log("old"); // retained\n');
  const duplicated = f.compare({ newOnly: true });
  assert.equal(duplicated.status, 'VIOLATIONS'); assert.equal(duplicated.exitCode, 1);
  assert.deepEqual(duplicated.baseline.counts, { new: 1, existing: 1, resolved: 0 });
  assert.equal(duplicated.findings[0].startLine, 1);
  assert.equal(duplicated.baseline.existingFindings[0].startLine, 2);
  f.write('src/main.js', 'const resolved = true;\n');
  const resolved = f.compare({ newOnly: true });
  assert.deepEqual(resolved.baseline.counts, { new: 0, existing: 0, resolved: 1 }); assert.equal(resolved.exitCode, 0);
});

test('renaming a file preserves its old occurrences while using the new path for reporting', t => {
  const f = fixture(t); f.git(['mv', 'src/main.js', 'src/renamed.js']);
  const report = f.compare({ newOnly: true });
  assert.equal(report.exitCode, 0); assert.deepEqual(report.baseline.counts, { new: 0, existing: 1, resolved: 0 });
  assert.equal(report.baseline.existingFindings[0].path, 'src/renamed.js');
  assert.equal(report.baseline.existingFindings[0].baselineLocation.path, 'src/main.js');
});

test('touched mode stays compatible while new-only distinguishes an old large function from a new one', t => {
  const old = 'function oldWork() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n';
  const f = fixture(t, { files: { 'src/main.js': old }, rules: [approved('function-max-lines', { max: 4 })] });
  f.write('src/main.js', old.replace('const b = 2;', 'const b = 4;') + '\nfunction newWork() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n');
  const touched = f.compare(); assert.equal(touched.resultScope, 'changed-node-ranges'); assert.equal(touched.findings.length, 2);
  const report = f.compare({ newOnly: true });
  assert.deepEqual(report.baseline.counts, { new: 1, existing: 1, resolved: 0 });
  assert.deepEqual(report.findings.map(finding => finding.symbol), ['newWork']);
  assert.equal(report.baseline.existingFindings[0].symbol, 'oldWork');
});

test('crossing a size limit creates a new violation instead of inheriting the function name', t => {
  const f = fixture(t, { files: { 'src/main.js': 'function work() {\n  return 1;\n}\n' }, rules: [approved('function-max-lines', { max: 4 })] });
  f.write('src/main.js', 'function work() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n');
  const report = f.compare({ newOnly: true });
  assert.deepEqual(report.baseline.counts, { new: 1, existing: 0, resolved: 0 }); assert.equal(report.exitCode, 1);
});

test('worsening an existing metric remains a new blocking finding', t => {
  const body = count => `function work() {\n${Array.from({ length: count }, (_, index) => `  const value${index} = ${index};`).join('\n')}\n  return 1;\n}\n`;
  const f = fixture(t, { files: { 'src/main.js': body(3) }, rules: [approved('function-max-lines', { max: 4 })] });
  f.write('src/main.js', body(22));
  const report = f.compare({ newOnly: true });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.baseline.counts, { new: 1, existing: 0, resolved: 0 });
  assert.equal(report.findings[0].baselineChange, 'worsened');
  assert.equal(report.findings[0].previousMetric.value, 6);
  assert.equal(report.findings[0].metric.value, 25);
});

test('same-named methods in different classes cannot grandfather each other', t => {
  const method = large => large ? '  run() {\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    return a + b + c;\n  }\n' : '  run() {\n    return 1;\n  }\n';
  const source = (left, right) => `class Left {\n${method(left)}}\nclass Right {\n${method(right)}}\n`;
  const f = fixture(t, { files: { 'src/main.js': source(true, false) }, rules: [approved('function-max-lines', { max: 4 })] });
  f.write('src/main.js', source(false, true));
  const report = f.compare({ newOnly: true });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.baseline.counts, { new: 1, existing: 0, resolved: 1 });
  assert.equal(report.findings[0].symbol, 'run');
  assert.ok(report.findings[0].startLine > report.baseline.resolvedFindings[0].startLine);
});

test('base and target parse errors remain incomplete rather than creating a false resolved baseline', t => {
  const f = fixture(t, { files: { 'src/main.js': 'function broken( {\n' } });
  f.write('src/main.js', 'const fixed = true;\n');
  const base = f.compare({ newOnly: true });
  assert.equal(base.status, 'INCOMPLETE'); assert.equal(base.exitCode, 2); assert.equal(base.baseline.status, 'INCOMPLETE'); assert.equal(base.baseline.counts, null);
  assert.ok(base.errors.some(error => error.reason === 'BASELINE_PARSE_ERROR'));
  f.write('src/main.js', 'function stillBroken( {\n');
  const target = f.compare({ newOnly: true });
  assert.equal(target.status, 'INCOMPLETE'); assert.ok(target.errors.some(error => error.reason === 'PARSE_ERROR'));
});

test('an imported or serialized diff cannot manufacture a new-only baseline', t => {
  const f = fixture(t); f.write('src/main.js', 'console.log("new");\n');
  const snapshot = diffFromGit(f.root, 'HEAD');
  const imported = f.review({ ...JSON.parse(JSON.stringify(snapshot)), newOnly: true });
  assert.equal(imported.status, 'INCOMPLETE'); assert.equal(imported.exitCode, 2);
  assert.ok(imported.errors.some(error => error.reason === 'BASELINE_REQUIRES_GIT_SNAPSHOT'));
});

test('a worktree changed after snapshot capture is rejected even if its new text still parses', t => {
  const f = fixture(t); f.write('src/main.js', 'console.log("first");\n');
  const snapshot = diffFromGit(f.root, 'HEAD');
  f.write('src/main.js', 'console.log("second");\n');
  const report = f.review({ ...snapshot, newOnly: true });
  assert.equal(report.status, 'INCOMPLETE'); assert.equal(report.exitCode, 2);
  assert.ok(report.errors.some(error => error.reason === 'WORKTREE_CHANGED_SINCE_CAPTURE'));
  assert.equal(report.baseline.counts, null);
});

test('untracked bytes changing after the analysis read invalidate the snapshot even when names stay unchanged', t => {
  const f = fixture(t, { files: { 'src/main.js': 'const stable = 1;\n' } });
  f.write('src/untracked.js', 'console.log("first");\n');
  const snapshot = diffFromGit(f.root, 'HEAD'), target = path.join(f.root, 'src/untracked.js');
  const originalRead = fs.readFileSync;
  let changed = false;
  t.mock.method(fs, 'readFileSync', function (filename, ...args) {
    const bytes = originalRead.call(this, filename, ...args);
    if (!changed && filename === target) { changed = true; fs.writeFileSync(target, 'console.log("second");\n'); }
    return bytes;
  });
  const report = f.review({ ...snapshot, newOnly: true });
  assert.ok(changed); assert.equal(report.exitCode, 2);
  assert.ok(report.errors.some(error => error.path === 'src/untracked.js' && error.reason === 'WORKTREE_CHANGED_DURING_REVIEW'));
  assert.equal(report.baseline.counts, null);
});

test('staged mode analyzes index blobs and ignores unstaged and untracked source contents', t => {
  const f = fixture(t, { files: { 'src/main.js': 'const value = 1;\n' } });
  const staged = 'console.log("staged");\n';
  f.write('src/main.js', staged); f.git(['add', 'src/main.js']);
  f.write('src/main.js', 'const unstaged = 2;\n'); f.write('src/untracked.js', 'console.log("untracked");\n');
  const report = f.compare({ staged: true, newOnly: true });
  assert.equal(report.git.target, 'index'); assert.equal(report.exitCode, 1);
  assert.deepEqual(report.baseline.counts, { new: 1, existing: 0, resolved: 0 });
  assert.deepEqual(report.sources.map(source => source.path), ['src/main.js']);
  assert.equal(report.sources[0].sha256, sha256(staged));
  assert.equal(report.sources[0].gitBlobOid, f.git(['rev-parse', ':src/main.js']).trim());
});

test('a changed index invalidates a captured staged comparison', t => {
  const f = fixture(t, { files: { 'src/main.js': 'const value = 1;\n' } });
  f.write('src/main.js', 'console.log("first");\n'); f.git(['add', 'src/main.js']);
  const snapshot = diffFromGit(f.root, 'HEAD', { staged: true });
  f.write('src/main.js', 'console.log("second");\n'); f.git(['add', 'src/main.js']);
  const report = f.review({ ...snapshot, newOnly: true });
  assert.equal(report.exitCode, 2); assert.ok(report.errors.some(error => error.reason === 'INDEX_CHANGED_SINCE_CAPTURE'));
});

test('merge-base records the requested ref, head and exact effective base on divergent branches', t => {
  const f = fixture(t, { files: { 'src/main.js': 'const value = 1;\n' } });
  const common = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['checkout', '--quiet', '-b', 'upstream']); f.write('src/main.js', 'console.log("upstream");\n'); f.git(['add', '.']); f.git(['commit', '--quiet', '-m', 'Upstream change']);
  const upstream = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['checkout', '--quiet', '-b', 'feature', common]); f.write('src/main.js', 'const value = 2;\n'); f.git(['add', '.']); f.git(['commit', '--quiet', '-m', 'Feature change']);
  const report = f.compare({ base: 'upstream', mergeBase: true, newOnly: true });
  assert.equal(report.git.requestedBase, 'upstream'); assert.equal(report.git.resolvedBase, upstream);
  assert.equal(report.git.baseCommit, common); assert.equal(report.git.baseMode, 'merge-base');
  assert.equal(report.git.headCommit, f.git(['rev-parse', 'HEAD']).trim());
  assert.deepEqual(report.baseline.counts, { new: 0, existing: 0, resolved: 0 });
  assert.equal(f.compare({ base: 'upstream', newOnly: true }).baseline.counts.resolved, 1);
});

test('effective policy changes force a complete scan including unchanged source files', t => {
  const f = fixture(t, { files: { 'src/main.js': 'console.log("legacy");\n', 'src/other.js': 'const other = 1;\n' }, rules: [approved('no-console', { allowMethods: ['log'] })] });
  writeJson(f.catalogPath, { schemaVersion: 1, rules: [approved('no-console')] });
  const report = f.compare({ newOnly: true });
  assert.equal(report.fullReviewReason, 'POLICY_CHANGED'); assert.equal(report.resultScope, 'full-project-policy-review');
  assert.deepEqual(report.selection, { mode: 'project' });
  assert.equal(report.baseline.status, 'POLICY_CHANGED_FULL_REVIEW'); assert.equal(report.baseline.newOnlyApplied, false);
  assert.equal(report.coverage.parsedFiles, 2); assert.equal(report.exitCode, 1); assert.equal(report.findings[0].path, 'src/main.js');
  assert.equal(f.compare().fullReviewReason, 'POLICY_CHANGED');
});

test('corroborating evidence alone does not change executable policy or invalidate occurrence comparison', t => {
  const f = fixture(t), { catalog } = f.open();
  const revised = { ...catalog.rules[0], evidence: [...catalog.rules[0].evidence, { kind: 'document', path: 'another.md', sha256: sha256('Additional evidence') }] };
  writeJson(f.catalogPath, { schemaVersion: 1, rules: [approveRule(revised, 'Reviewer', 'Corroborating evidence')] });
  f.write('src/main.js', '// moved\nconsole.log("old");\n');
  const report = f.compare({ newOnly: true });
  assert.equal(report.policyComparison.status, 'UNCHANGED'); assert.equal(report.fullReviewReason, null);
  assert.deepEqual(report.baseline.counts, { new: 0, existing: 1, resolved: 0 }); assert.equal(report.exitCode, 0);
});

test('unavailable policy history falls back to a full scan and never claims proven new-only gating', t => {
  const f = fixture(t, { externalPolicy: true }); f.write('README.md', 'notes\n');
  assert.equal(f.compare().status, 'NOT_APPLICABLE');
  const report = f.compare({ newOnly: true });
  assert.equal(report.fullReviewReason, 'POLICY_HISTORY_UNAVAILABLE'); assert.equal(report.baseline.status, 'POLICY_HISTORY_UNAVAILABLE');
  assert.equal(report.baseline.newOnlyApplied, false); assert.equal(report.baseline.counts, null);
  assert.equal(report.exitCode, 1); assert.equal(report.findings.length, 1);
});

test('staged code cannot be checked with a materially different unstaged policy', t => {
  const f = fixture(t, { files: { 'src/main.js': 'const value = 1;\n' }, rules: [approved('no-console', { allowMethods: ['log'] })] });
  f.write('src/main.js', 'console.log("staged");\n'); f.git(['add', 'src/main.js']);
  writeJson(f.catalogPath, { schemaVersion: 1, rules: [approved('no-console')] });
  const report = f.compare({ staged: true, newOnly: true });
  assert.equal(report.exitCode, 2); assert.ok(report.errors.some(error => error.reason === 'STAGED_POLICY_MISMATCH'));
});
