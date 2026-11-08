import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { createFlatConfig, createPlugin, describeEslintCoverage } from '../src/eslint.mjs';
import { approveRule } from '../src/rules.mjs';
import { loadConfig, loadCatalog, resolveRules } from '../src/config.mjs';
import { analyzeSource } from '../src/ast.mjs';
import { sha256 } from '../src/util.mjs';

function candidate(id, scope, kind, options = {}, extra = {}) {
  return {
    id, family: kind, title: id, description: 'Synthetic test rule', scope,
    status: 'candidate', severity: 'error', mode: 'enforce', check: { kind, options },
    evidence: [{ kind: 'manual', path: 'synthetic.txt', sha256: sha256('synthetic') }],
    ...extra,
  };
}
const approved = (...args) => approveRule(candidate(...args), 'test', 'Synthetic fixture acceptance');

function fixture(t, rules, bestPractices = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreview-eslint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'b', 'src'), { recursive: true });
  const configPath = path.join(directory, 'selfreview.config.json');
  const catalogPath = path.join(directory, 'catalog.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, catalog: './catalog.json', bestPractices,
    scopes: [{ id: 'scope-a' }, { id: 'scope-b' }],
    projects: [{ id: 'a', root: './a', scope: 'scope-a' }, { id: 'b', root: './b', scope: 'scope-b' }],
  }));
  fs.writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, rules }));
  return { directory, configPath, catalogPath };
}

function linter(f, configuration, parser = false) {
  return new ESLint({
    cwd: f.directory, overrideConfigFile: true,
    overrideConfig: [...configuration, ...(parser ? [{ files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'], languageOptions: { parser: tsParser } }] : [])],
  });
}

test('ESLint uses the same AST results and actual buffer text, not the on-disk source', async t => {
  const f = fixture(t, [approved('no-var-a', 'scope-a', 'no-var'), approved('console-a', 'scope-a', 'no-console')]);
  const filename = path.join(f.directory, 'a', 'src', 'file.js');
  fs.writeFileSync(filename, 'const clean = 1;');
  const source = 'var changed = 1;\nconsole.log(changed);';
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText(source, { filePath: filename });
  const context = loadConfig(f.configPath), catalog = loadCatalog(context);
  const core = analyzeSource(source, 'src/file.js', resolveRules(context.config, catalog, 'scope-a', 'src/file.js').rules);
  assert.equal(result.errorCount, 2);
  assert.deepEqual(result.messages.map(message => [message.ruleId, message.line, message.column]),
    core.findings.map(finding => [`selfreview/check.${finding.ruleId}`, finding.startLine, finding.column]));
  const [clean] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('const clean = 1;', { filePath: filename });
  assert.equal(clean.messages.length, 0);
});

test('TSX results retain full component ranges through the host TypeScript parser', async t => {
  const f = fixture(t, [approved('component-a', 'scope-a', 'component-max-lines', { max: 2 })]);
  const source = 'export const Card = (props: { label: string }) => {\n  const label = props.label;\n  return <div>{label}</div>;\n};';
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a'), true).lintText(source, { filePath: path.join(f.directory, 'a', 'src', 'Card.tsx') });
  const context = loadConfig(f.configPath), catalog = loadCatalog(context);
  const core = analyzeSource(source, 'src/Card.tsx', resolveRules(context.config, catalog, 'scope-a', 'src/Card.tsx').rules);
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, 'selfreview/check.component-a');
  assert.equal(result.messages[0].line, core.findings[0].startLine);
  assert.equal(result.messages[0].endLine, core.findings[0].endLine);
  assert.equal(result.messages[0].message, core.findings[0].message);
});

test('project scope and per-rule applicability do not leak to another project or folder', async t => {
  const f = fixture(t, [approved('console-a', 'scope-a', 'no-console', {}, { applicability: { include: ['src/**/*.js'] } })]);
  const eslint = linter(f, [...createFlatConfig(f.configPath, 'a'), ...createFlatConfig(f.configPath, 'b')]);
  const [a] = await eslint.lintText('console.log(1);', { filePath: path.join(f.directory, 'a', 'src', 'file.js') });
  const [b] = await eslint.lintText('console.log(1);', { filePath: path.join(f.directory, 'b', 'src', 'file.js') });
  const [tests] = await eslint.lintText('console.log(1);', { filePath: path.join(f.directory, 'a', 'test', 'file.js') });
  assert.equal(a.errorCount, 1);
  assert.equal(b.messages.length, 0);
  assert.equal(tests.messages.length, 0);
});

test('best-practice advice remains an ESLint warning and can be superseded by convention', async t => {
  const f = fixture(t, [], true);
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('var value = "abc".substr(1);', { filePath: path.join(f.directory, 'a', 'file.js') });
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 2);
  assert.ok(result.messages.every(message => message.severity === 1));
  const projectConvention = approved('legacy-allowed', 'scope-a', 'manual', {}, { family: 'restricted-call', mode: 'advisory', severity: 'info' });
  fs.writeFileSync(f.catalogPath, JSON.stringify({ schemaVersion: 1, rules: [projectConvention] }));
  const [allowed] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('"abc".substr(1);', { filePath: path.join(f.directory, 'a', 'file.js') });
  assert.equal(allowed.messages.length, 0);
});

test('conflicting approved variants produce an integrity error and no contradictory enforcement', async t => {
  const f = fixture(t, [approved('first', 'scope-a', 'no-console'), approved('second', 'scope-a', 'no-console', { allowMethods: ['log'] })]);
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('console.log(1);', { filePath: path.join(f.directory, 'a', 'file.js') });
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, 'selfreview/integrity');
  assert.match(result.messages[0].message, /RULE_CONFLICT/);
});

test('stale approvals fail when the configuration is loaded', t => {
  const rule = approved('console-a', 'scope-a', 'no-console');
  rule.check.options.allowMethods = ['log'];
  const f = fixture(t, [rule]);
  assert.throws(() => createFlatConfig(f.configPath, 'a'), /STALE_APPROVAL/);
});

test('manual and candidate rules are explicitly absent from enforced ESLint coverage', async t => {
  const f = fixture(t, [candidate('suggestion', 'scope-a', 'no-console'), approved('responsibilities', 'scope-a', 'manual')]);
  const config = createFlatConfig(f.configPath, 'a');
  const context = loadConfig(f.configPath), catalog = loadCatalog(context);
  const coverage = describeEslintCoverage(context, catalog, 'a');
  assert.deepEqual(coverage.exportedRuleIds, []);
  assert.deepEqual(coverage.manualRuleIds, ['responsibilities']);
  assert.deepEqual(coverage.candidateRuleIds, ['suggestion']);
  assert.deepEqual(Object.keys(config[0].rules), ['selfreview/integrity']);
  const [result] = await linter(f, config).lintText('console.log(1);', { filePath: path.join(f.directory, 'a', 'file.js') });
  assert.equal(result.messages.length, 0);
});

test('direct plugin use detects a filename outside the selected project', async t => {
  const f = fixture(t, [approved('console-a', 'scope-a', 'no-console')]);
  const context = loadConfig(f.configPath), catalog = loadCatalog(context);
  const plugin = createPlugin(context, catalog, 'a');
  const config = [{ files: ['**/*.js'], plugins: { selfreview: plugin }, rules: { 'selfreview/integrity': 'error', 'selfreview/check.console-a': 'error' } }];
  const [result] = await linter(f, config).lintText('console.log(1);', { filePath: path.join(f.directory, 'b', 'file.js') });
  assert.equal(result.errorCount, 1);
  assert.match(result.messages[0].message, /OUTSIDE_PROJECT_ROOT/);
});

test('symlink paths cannot redirect the adapter outside its project scope', async t => {
  const f = fixture(t, [approved('console-a', 'scope-a', 'no-console')]);
  const target = path.join(f.directory, 'b', 'target.js');
  fs.writeFileSync(target, 'console.log(1);');
  const link = path.join(f.directory, 'a', 'link.js');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS did not permit creation of a symlink'); return; } throw error; }
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('console.log(1);', { filePath: link });
  assert.equal(result.errorCount, 1);
  assert.match(result.messages[0].message, /FILE_ESCAPES_PROJECT_ROOT/);
});

test('a parser failure is an ESLint error, never a successful empty review', async t => {
  const f = fixture(t, [approved('no-var-a', 'scope-a', 'no-var')]);
  const [result] = await linter(f, createFlatConfig(f.configPath, 'a')).lintText('function broken( {', { filePath: path.join(f.directory, 'a', 'file.js') });
  assert.ok(result.errorCount > 0);
  assert.ok(result.messages.some(message => message.fatal));
});
