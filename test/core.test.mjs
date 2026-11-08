import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadCatalog, mutateCatalog, resolveRules } from '../src/config.mjs';
import { approveRule, behaviorHash, validateRule } from '../src/rules.mjs';
import { reviewProject } from '../src/review.mjs';
import { sha256, readJson, writeJson } from '../src/util.mjs';

// Every project is an isolated real directory outside the configuration folder.
// These tests never run against a developer checkout or modify source under test.
function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreview-core-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const settings = path.join(temporary, 'settings');
  fs.mkdirSync(settings, { recursive: true });
  const projects = (options.projects ?? [{ id: 'app', scope: 'team' }])
    .map(project => ({ root: `../projects/${project.id}`, ...project }));
  const roots = new Map();
  for (const project of projects) {
    const root = path.resolve(settings, project.root);
    roots.set(project.id, root);
    fs.mkdirSync(root, { recursive: true });
  }
  const files = options.files ?? { app: { 'src/index.ts': 'export const value = 1;\n' } };
  for (const [projectId, sources] of Object.entries(files)) {
    for (const [relative, source] of Object.entries(sources)) {
      const filename = path.join(roots.get(projectId), relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, source);
    }
  }
  const config = {
    schemaVersion: 1,
    scopes: options.scopes ?? [{ id: 'team' }],
    projects,
    bestPractices: options.bestPractices ?? false,
    catalog: 'catalog.json',
  };
  const configPath = path.join(settings, 'selfreview.config.json');
  const catalogPath = path.join(settings, 'catalog.json');
  writeJson(configPath, config);
  writeJson(catalogPath, { schemaVersion: 1, rules: options.rules ?? [] });
  const open = () => loadConfig(configPath);
  const review = (id = 'app', reviewOptions = {}) => {
    const context = open();
    return reviewProject(context, loadCatalog(context), id, reviewOptions);
  };
  return { temporary, settings, roots, config, configPath, catalogPath, open, review };
}

function candidate(overrides = {}) {
  return {
    id: 'team.no-var', family: 'no-var', scope: 'team',
    title: 'Use block scoped declarations',
    description: 'Synthetic team convention for integration tests.',
    status: 'candidate', severity: 'error', mode: 'enforce',
    check: { kind: 'no-var', options: {} },
    evidence: [{
      kind: 'document', path: 'synthetic-conventions.md',
      sha256: sha256('Use block scoped declarations.'),
      excerpt: 'Use block scoped declarations.',
    }],
    ...overrides,
  };
}

function approved(overrides = {}) {
  return approveRule(candidate(overrides), 'fixture-reviewer', 'Reviewed the synthetic convention.', '2026-11-08T00:00:00.000Z');
}

function sourceSnapshot(root) {
  const records = [];
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      const relative = path.relative(root, filename);
      if (stat.isSymbolicLink()) records.push([relative, 'link', fs.readlinkSync(filename)]);
      else if (stat.isDirectory()) visit(filename);
      else records.push([relative, sha256(fs.readFileSync(filename)), stat.mtimeMs]);
    }
  };
  visit(root);
  return records;
}

function createLinkOrSkip(t, target, filename, type) {
  try { fs.symlinkSync(target, filename, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EROFS'].includes(error.code)) {
      t.skip(`The operating system denied symlink creation: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('scope A is isolated from the shared B/C/D scope and independent E scope', t => {
  const projects = [
    { id: 'a', scope: 'a' }, { id: 'b', scope: 'bcd' },
    { id: 'c', scope: 'bcd' }, { id: 'd', scope: 'bcd' }, { id: 'e', scope: 'e' },
  ];
  const source = 'var value = 1;\nconsole.log(value);\n';
  const f = fixture(t, {
    scopes: [{ id: 'a' }, { id: 'bcd' }, { id: 'e' }], projects,
    files: Object.fromEntries(projects.map(p => [p.id, { 'src/index.ts': source }])),
    rules: [
      approved({ id: 'a.no-console', family: 'no-console', scope: 'a', check: { kind: 'no-console', options: {} } }),
      approved({ id: 'bcd.no-var', scope: 'bcd' }),
    ],
  });
  assert.deepEqual(f.review('a').findings.map(r => r.ruleId), ['a.no-console']);
  for (const id of ['b', 'c', 'd']) {
    const report = f.review(id);
    assert.equal(report.scope, 'bcd');
    assert.equal(report.status, 'VIOLATIONS');
    assert.deepEqual(report.findings.map(r => r.ruleId), ['bcd.no-var']);
  }
  const e = f.review('e');
  assert.equal(e.status, 'ADVISORY_ONLY');
  assert.equal(e.coverage.enforcedAstRules, 0);
  assert.deepEqual(e.findings, []);
});

test('candidate and rejected rules never become enforced by confidence or evidence', t => {
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'var value = 1;\nconsole.log(value);\n' } },
    rules: [
      candidate({ confidence: 1 }),
      candidate({ id: 'team.console', family: 'no-console', status: 'rejected', check: { kind: 'no-console' } }),
    ],
  });
  const report = f.review();
  assert.equal(report.status, 'ADVISORY_ONLY');
  assert.equal(report.coverage.candidateRulesNotEnforced, 1);
  assert.equal(report.coverage.enforcedAstRules, 0);
  assert.deepEqual(report.findings, []);
});

test('overlapping same-family variants block review until an explicit override is approved', t => {
  const base = approved({ id: 'base.console', scope: 'base', family: 'no-console', check: { kind: 'no-console', options: {} } });
  const variant = approved({ id: 'team.console', family: 'no-console', check: { kind: 'no-console', options: { allowMethods: ['warn'] } } });
  const f = fixture(t, {
    scopes: [{ id: 'base' }, { id: 'team', extends: ['base'] }],
    files: { app: { 'src/index.ts': 'console.warn("allowed by the narrower convention");\n' } },
    rules: [base, variant],
  });
  const blocked = f.review();
  assert.equal(blocked.status, 'INCOMPLETE');
  assert.equal(blocked.exitCode, 2);
  assert.ok(blocked.errors.some(e => e.reason === 'OVERLAPPING_RULE_VARIANTS_REQUIRE_EXPLICIT_OVERRIDE'));

  const explicit = approveRule({
    ...variant,
    overrides: [base.id],
    overrideReason: 'Warnings are permitted in this application.',
  }, 'fixture-reviewer', 'Reviewed the narrower override.');
  writeJson(f.catalogPath, { schemaVersion: 1, rules: [base, explicit] });
  const result = f.review();
  assert.equal(result.status, 'CHECKS_PASSED');
  assert.deepEqual(result.findings, []);
  assert.ok(result.suppressed.some(s => s.id === base.id && s.by === explicit.id && s.reason === explicit.overrideReason));
});

test('disjoint file variants of one family apply without imposing global equality', t => {
  const f = fixture(t, {
    files: { app: { 'src/view.ts': 'console.log("source");\n', 'test/view.test.ts': 'console.log("test");\n' } },
    rules: [
      approved({ id: 'team.source-console', family: 'no-console', applicability: { include: ['src/**'] }, check: { kind: 'no-console' } }),
      approved({ id: 'team.test-console', family: 'no-console', applicability: { include: ['test/**'] }, check: { kind: 'no-console', options: { allowMethods: ['log'] } } }),
    ],
  });
  const report = f.review();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.findings.map(r => [r.path, r.ruleId]), [['src/view.ts', 'team.source-console']]);
});

test('override cycles cannot hide every enforced rule and manufacture a pass', t => {
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'var cyclic = true;\n' } },
    rules: [
      approved({ id: 'team.first', overrides: ['team.second'], overrideReason: 'Synthetic first edge.' }),
      approved({ id: 'team.second', overrides: ['team.first'], overrideReason: 'Synthetic second edge.' }),
    ],
  });
  const report = f.review();
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.ok(report.errors.some(e => e.reason === 'OVERRIDE_CYCLE'));
});

test('a convention cannot override a same-family rule from an unrelated scope', t => {
  const f = fixture(t, {
    scopes: [{ id: 'team' }, { id: 'unrelated' }],
    rules: [
      approved({ id: 'unrelated.no-var', scope: 'unrelated' }),
      approved({ overrides: ['unrelated.no-var'], overrideReason: 'Invalid cross-scope override.' }),
    ],
  });
  const report = f.review();
  assert.equal(report.status, 'INCOMPLETE');
  assert.ok(report.errors.some(e => e.reason === 'INVALID_OVERRIDE_TARGET'));
});

test('approval hashes bind behavior, applicability, scope and evidence', () => {
  const original = approved({ family: 'function-max-lines', check: { kind: 'function-max-lines', options: { max: 10 } } });
  const mutations = [
    r => { r.check.options.max = 100; },
    r => { r.mode = 'advisory'; },
    r => { r.scope = 'other'; },
    r => { r.applicability = { include: ['legacy/**'] }; },
    r => { r.evidence[0].sha256 = sha256('different source'); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateRule(changed), /STALE_APPROVAL/);
  }
});

test('stale approvals prevent review and two drifted rules can be repaired sequentially', t => {
  const first = approved();
  const second = approved({ id: 'team.console', family: 'no-console', check: { kind: 'no-console', options: { allowMethods: [] } } });
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'var value = 1;\nconsole.warn(value);\n' } }, rules: [first, second],
  });
  const drifted = readJson(f.catalogPath);
  drifted.rules[0].mode = 'advisory';
  drifted.rules[1].check.options.allowMethods = ['warn'];
  writeJson(f.catalogPath, drifted);
  assert.throws(() => f.review(), /STALE_APPROVAL/);

  mutateCatalog(f.open(), catalog => {
    catalog.rules[0] = approveRule(catalog.rules[0], 'fixture-reviewer', 'Reviewed first change.');
  }, { allowStale: true });
  const intermediate = readJson(f.catalogPath);
  assert.equal(intermediate.rules[0].approval.behaviorHash, behaviorHash(intermediate.rules[0]));
  assert.throws(() => f.review(), /STALE_APPROVAL/);

  mutateCatalog(f.open(), catalog => {
    catalog.rules[1] = approveRule(catalog.rules[1], 'fixture-reviewer', 'Reviewed second change.');
  }, { allowStale: true });
  const repaired = f.review();
  assert.equal(repaired.exitCode, 0);
  assert.deepEqual(repaired.errors, []);
  assert.ok(!fs.existsSync(`${f.catalogPath}.lock`));
});

test('a missing catalog is an error rather than an empty or satisfied policy', t => {
  const f = fixture(t, { rules: [approved()] });
  fs.unlinkSync(f.catalogPath);
  assert.throws(() => f.review(), /catalog is missing/i);
});

test('invalid applicability cannot silently widen a rule to all source files', () => {
  for (const applicability of [false, 0, '', null, [], { include: [] }, { include: ['**/*.ts', '[bad'] }, { exclude: ['**/*', '[bad'] }]) {
    assert.throws(() => validateRule(candidate({ applicability })), undefined, JSON.stringify(applicability));
  }
  assert.throws(() => validateRule(candidate({ id: undefined })), /Rule id/);
  assert.throws(() => validateRule(candidate({ id: 123 })), /Rule id/);
  assert.throws(() => validateRule(candidate({ scope: undefined })), /scope/);
});

for (const [label, projectFields] of [
  ['an empty include', { include: [] }],
  ['a string in place of include', { include: '**/*.ts' }],
  ['an invalid later include pattern', { include: ['**/*.ts', '[broken'] }],
  ['an invalid later exclude pattern', { exclude: ['**/*', '[broken'] }],
  ['an invalid exclude despite a nonmatching include', { include: ['**/*.tsx'], exclude: ['[broken'] }],
]) {
  test(`project configuration rejects ${label}`, t => {
    const f = fixture(t, { projects: [{ id: 'app', scope: 'team', ...projectFields }] });
    assert.throws(() => f.open(), /include|exclude|glob/i);
  });
}

test('an approved convention suppresses the equivalent builtin even with a custom family name', t => {
  const f = fixture(t, {
    bestPractices: true,
    files: { app: { 'src/index.ts': 'export function legacy(a, b, c, d, e, f) { return a; }\n' } },
    rules: [approved({
      id: 'team.parameters', family: 'team-public-api-arity',
      check: { kind: 'max-parameters', options: { max: 8 } },
    })],
  });
  const report = f.review();
  assert.equal(report.status, 'CHECKS_PASSED');
  assert.deepEqual(report.findings, []);
  assert.ok(report.suppressed.some(s => s.id === 'bp.parameters' && s.by === 'convention'));
});

test('explicit disabling of a builtin preserves its explanation', t => {
  const reason = 'This legacy subsystem intentionally retains function-scoped declarations.';
  const f = fixture(t, {
    bestPractices: true,
    scopes: [{ id: 'team', disabledRules: [{ id: 'bp.no-var', reason }] }],
    files: { app: { 'src/index.ts': 'var legacy = 1;\n' } },
  });
  const report = f.review();
  assert.deepEqual(report.findings, []);
  assert.ok(report.suppressed.some(s => s.id === 'bp.no-var' && s.reason === reason && s.by === 'scope'));
  f.config.scopes[0].disabledRules[0].reason = ' ';
  writeJson(f.configPath, f.config);
  assert.throws(() => f.open(), /disabledRules require id and reason/);
});

test('a parse error makes partial review INCOMPLETE even if another file is checked', t => {
  const f = fixture(t, {
    files: { app: { 'src/broken.tsx': 'export const Broken = () => <section;\n', 'src/good.ts': 'var legacy = 1;\n' } },
    rules: [approved()],
  });
  const report = f.review();
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.equal(report.coverage.selectedFiles, 2);
  assert.equal(report.coverage.parsedFiles, 1);
  assert.ok(report.errors.some(e => e.reason === 'PARSE_ERROR' && e.path === 'src/broken.tsx'));
  assert.deepEqual(report.findings.map(r => r.path), ['src/good.ts']);
});

const changedFunctionSource = [
  'export function changed() {',
  '  const first = 1;',
  '  const second = 2;',
  '  const third = 3;',
  '  return first + third;',
  '}',
  '',
  'export function untouched() {',
  '  const first = 1;',
  '  const second = 2;',
  '  const third = 3;',
  '  return first + third;',
  '}',
  '',
].join('\n');

const changedFunctionDiff = [
  'diff --git a/src/functions.ts b/src/functions.ts',
  '--- a/src/functions.ts',
  '+++ b/src/functions.ts',
  '@@ -2,0 +3 @@',
  '+  const second = 2;',
  '',
].join('\n');

test('diff review analyzes a complete touched function when its heading is outside added lines', t => {
  const f = fixture(t, {
    files: { app: { 'src/functions.ts': changedFunctionSource } },
    rules: [approved({ id: 'team.function-size', family: 'function-max-lines', check: { kind: 'function-max-lines', options: { max: 5 } } })],
  });
  assert.deepEqual(f.review().findings.map(r => r.symbol), ['changed', 'untouched']);
  const report = f.review('app', { diffText: changedFunctionDiff });
  assert.equal(report.status, 'VIOLATIONS');
  assert.equal(report.resultScope, 'changed-node-ranges');
  assert.deepEqual(report.findings.map(r => r.symbol), ['changed']);
  assert.equal(report.findings[0].startLine, 1);
  assert.equal(report.findings[0].endLine, 6);
  assert.equal(report.findings[0].changeRelation, 'touches-change');
  assert.deepEqual(report.errors, []);
});

test('unchanged violations in the same file are excluded from changed-node findings', t => {
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'var existing = 1;\nconst added = 2;\n' } }, rules: [approved()],
  });
  assert.equal(f.review().findings.length, 1);
  const diffText = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,0 +2 @@\n+const added = 2;\n';
  const report = f.review('app', { diffText });
  assert.equal(report.status, 'CHECKS_PASSED');
  assert.deepEqual(report.findings, []);
  assert.equal(report.coverage.parsedFiles, 1);
});

test('stale postimage text is refused and the supplied patch is never applied', t => {
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'const value = 3;\n' } }, rules: [approved()],
  });
  const before = sourceSnapshot(f.roots.get('app'));
  const diffText = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n';
  const report = f.review('app', { diffText });
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.ok(report.errors.some(e => e.reason === 'STALE_DIFF_POSTIMAGE_MISMATCH'));
  assert.deepEqual(sourceSnapshot(f.roots.get('app')), before);
});

for (const [label, diffText] of [
  ['truncated hunk', '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,0 +1,2 @@\n+const value = 1;\n'],
  ['non-patch text', 'Please review this code without an actual patch.'],
  ['path traversal', '--- a/../outside.ts\n+++ b/../outside.ts\n@@ -1 +1 @@\n-var value = 1;\n+const value = 1;\n'],
]) {
  test(`malformed diff (${label}) never becomes an empty successful review`, t => {
    const f = fixture(t, { rules: [approved()] });
    const report = f.review('app', { diffText });
    assert.equal(report.status, 'INCOMPLETE');
    assert.equal(report.exitCode, 2);
    assert.ok(report.errors.some(e => e.reason === 'INVALID_DIFF'));
  });
}

test('an empty diff reports NO_CHANGES instead of full-project verification', t => {
  const f = fixture(t, {
    files: { app: { 'src/index.ts': 'var oldViolation = 1;\n' } }, rules: [approved()],
  });
  const report = f.review('app', { diffText: '' });
  assert.equal(report.status, 'NO_CHANGES');
  assert.equal(report.coverage.selectedFiles, 0);
  assert.equal(report.coverage.parsedFiles, 0);
  assert.deepEqual(report.findings, []);
});

test('configured roots outside the config directory do not include a sibling sharing a path prefix', t => {
  const f = fixture(t, {
    projects: [{ id: 'app', scope: 'team' }, { id: 'app-backup', scope: 'team' }],
    files: {
      app: { 'src/index.ts': 'export const clean = 1;\n' },
      'app-backup': { 'src/outside.ts': 'var forbidden = 1;\n' },
    },
    rules: [approved()],
  });
  fs.writeFileSync(path.join(f.temporary, 'outside.ts'), 'var anotherUnselectedFile = 1;\n');
  const primary = f.review();
  assert.equal(primary.status, 'CHECKS_PASSED');
  assert.equal(primary.coverage.selectedFiles, 1);
  assert.deepEqual(primary.sources.map(s => s.path), ['src/index.ts']);
  assert.equal(f.review('app-backup').status, 'VIOLATIONS');
});

test('overlapping project roots and scope inheritance cycles are rejected', t => {
  const f = fixture(t, {
    projects: [
      { id: 'app', scope: 'team', root: '../projects/app' },
      { id: 'nested', scope: 'team', root: '../projects/app/child' },
    ],
  });
  assert.throws(() => f.open(), /overlapping project roots/i);
  f.config.projects = [f.config.projects[0]];
  f.config.scopes = [{ id: 'team', extends: ['base'] }, { id: 'base', extends: ['team'] }];
  writeJson(f.configPath, f.config);
  assert.throws(() => f.open(), /inheritance cycle/i);
});

test('source-file symlinks are not followed and prevent a complete review', t => {
  const f = fixture(t, { rules: [approved()] });
  const outside = path.join(f.temporary, 'outside.ts');
  fs.writeFileSync(outside, 'var external = 1;\n');
  const link = path.join(f.roots.get('app'), 'src', 'external.ts');
  if (!createLinkOrSkip(t, outside, link, 'file')) return;
  const report = f.review();
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.ok(report.skipped.some(s => s.path === 'src/external.ts' && s.reason === 'SYMLINK_NOT_FOLLOWED'));
  assert.ok(!report.sources.some(s => s.path === 'src/external.ts'));
  assert.deepEqual(report.findings, []);
});

test('directory symlinks cannot conceal selected source behind a CHECKS_PASSED result', t => {
  const f = fixture(t, { rules: [approved()] });
  const outside = path.join(f.temporary, 'external-sources');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'hidden.ts'), 'var hidden = 1;\n');
  const link = path.join(f.roots.get('app'), 'src', 'linked');
  if (!createLinkOrSkip(t, outside, link, process.platform === 'win32' ? 'junction' : 'dir')) return;
  const report = f.review();
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.exitCode, 2);
  assert.ok(report.skipped.some(s => s.path === 'src/linked' && s.reason === 'SYMLINK_NOT_FOLLOWED'));
  assert.ok(!report.sources.some(s => s.path.startsWith('src/linked/')));
  assert.deepEqual(report.findings, []);
});

test('review preserves every source byte and mtime as well as configuration and catalog', t => {
  const f = fixture(t, {
    files: { app: {
      'src/index.ts': 'var legacy = 1;\nconsole.log(legacy);\n',
      'src/view.tsx': 'export const View = () => <article>Hello</article>;\n',
      'notes.txt': 'This file is outside AST coverage.\n',
    } },
    rules: [approved()], bestPractices: true,
  });
  const before = sourceSnapshot(f.roots.get('app'));
  const configBefore = fs.readFileSync(f.configPath);
  const catalogBefore = fs.readFileSync(f.catalogPath);
  assert.equal(f.review().status, 'VIOLATIONS');
  assert.deepEqual(sourceSnapshot(f.roots.get('app')), before);
  assert.deepEqual(fs.readFileSync(f.configPath), configBefore);
  assert.deepEqual(fs.readFileSync(f.catalogPath), catalogBefore);
});

test('manual conventions remain an explicit checklist instead of a fabricated AST pass', t => {
  const f = fixture(t, {
    rules: [approved({ id: 'team.responsibility', family: 'responsibility', title: 'Keep one responsibility', check: { kind: 'manual' } })],
  });
  const report = f.review();
  assert.equal(report.status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(report.coverage.enforcedAstRules, 0);
  assert.deepEqual(report.manualChecklist.map(r => r.id), ['team.responsibility']);
  assert.deepEqual(report.findings, []);
});

test('unknown scope resolution cannot silently select global advice', t => {
  const f = fixture(t, { bestPractices: true });
  const context = f.open();
  assert.throws(() => resolveRules(context.config, loadCatalog(context), 'unknown', 'src/index.ts'), /Unknown scope/);
});
