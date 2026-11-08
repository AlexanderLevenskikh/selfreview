import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource, SUPPORTED_CHECKS } from '../src/ast.mjs';

function rule(kind, options = {}, extra = {}) {
  return { id: `test-${kind}`, family: kind, title: kind, severity: 'error', mode: 'enforce', check: { kind, options }, evidence: [], ...extra };
}

test('no-var analyzes syntax, excludes strings/comments, and preserves location', () => {
  const source = '// var x = 1; console.log(1);\nconst text = "var fake = 1";\nvar count = 1;\nlet next = count;';
  const result = analyzeSource(source, 'sample.ts', [rule('no-var'), rule('no-console')]);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, 'test-no-var');
  assert.equal(result.findings[0].startLine, 3);
  assert.equal(result.findings[0].column, 1);
  assert.deepEqual(result.metrics.declarations, { const: 1, let: 1, var: 1 });
  assert.equal(result.coverage.typeChecked, false);
});

test('console rule respects permitted methods and catches computed/optional access', () => {
  const source = 'console.log("x");\nconsole.warn("y");\nconsole["log"]("z");\nconsole?.error("e");';
  const result = analyzeSource(source, 'sample.js', [rule('no-console', { allowMethods: ['warn'] })]);
  assert.deepEqual(result.findings.map(finding => finding.startLine), [1, 3, 4]);
});

test('single-file binding excludes locally shadowed console, including hoisted variables and parameters', () => {
  const source = `
console.log('global before');
function parameter(console) { console.log('local'); }
function hoisted() { console.log('local'); var console = {}; }
{ let console = {}; console.log('block'); }
console.log('global after');
`;
  const result = analyzeSource(source, 'sample.js', [rule('no-console')]);
  assert.deepEqual(result.findings.map(finding => finding.startLine), [2, 6]);
});

test('an imported or destructured console binding is not the global console', () => {
  const imported = analyzeSource('import console from "custom-console"; console.log("local");', 'sample.ts', [rule('no-console')]);
  const destructured = analyzeSource('function f({console}) { console.log("local"); }', 'sample.js', [rule('no-console')]);
  assert.equal(imported.findings.length, 0);
  assert.equal(destructured.findings.length, 0);
});

test('strict equality can retain the explicit null comparison convention', () => {
  const source = 'a == b; a != null; null == b; a === b; a !== b;';
  const strict = analyzeSource(source, 'sample.js', [rule('strict-equality')]);
  const nullAllowed = analyzeSource(source, 'sample.js', [rule('strict-equality', { allowNull: true })]);
  assert.equal(strict.findings.length, 3);
  assert.equal(nullAllowed.findings.length, 1);
  assert.deepEqual(strict.metrics.equality, { strict: 2, loose: 3, nullLoose: 2 });
});

test('restricted imports cover static imports, reexports, require, dynamic imports and TS import types', () => {
  const source = `
import a from 'legacy';
export { b } from 'legacy/sub';
const c = require('legacy');
const d = import('legacy');
type E = import('legacy').Type;
import f = require('legacy');
function local(require: any) { return require('legacy'); }
const note = "import 'legacy'";
`;
  const result = analyzeSource(source, 'sample.ts', [rule('restricted-import', { modules: ['legacy', 'legacy/*'] })]);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.findings.length, 6);
  assert.deepEqual(result.findings.map(finding => finding.startLine), [2, 3, 4, 5, 6, 7]);
  assert.equal(result.metrics.imports.length, 6);
});

test('restricted calls support exact paths and wildcard methods without claiming type resolution', () => {
  const source = `
document.write('bad');
document['write']('also');
'hello'.substr(1);
getValue().substr(1);
getValue().substring(1);
const note = 'document.write(1)';
`;
  const result = analyzeSource(source, 'sample.js', [rule('restricted-call', { callees: ['document.write', '*.substr'] })]);
  assert.equal(result.findings.length, 4);
  assert.ok(result.findings.every(finding => finding.matchPrecision === 'syntax'));
  assert.ok(result.findings.every(finding => /verify receiver type/.test(finding.message)));
});

test('TSX component size spans the full AST node, even if the change is in its body', () => {
  const source = `import React from 'react';
export const LargeCard = () => {
  const label = 'hello';
  // A change here must intersect the finding, even though the declaration is above.
  return <section>{label}</section>;
};
const helper = () => <span />;
function APIClient() { return 1; }
`;
  const result = analyzeSource(source, 'sample.tsx', [rule('component-max-lines', { max: 3 })]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].symbol, 'LargeCard');
  assert.equal(result.findings[0].startLine, 2);
  assert.equal(result.findings[0].endLine, 6);
  assert.equal(result.findings[0].metric.value, 5);
  assert.equal(result.metrics.functions.filter(item => item.component).length, 1);
});

test('memo-wrapped/default/class components are structurally detected', () => {
  const source = `const Wrapped = memo(() => {
  return <div />;
});
export default function() {
  return <span />;
}
class Card extends React.Component {
  state = {};
  render() {
    return <section />;
  }
}`;
  const result = analyzeSource(source, 'sample.tsx', [rule('component-max-lines', { max: 2 })]);
  assert.equal(result.parseErrors.length, 0);
  assert.deepEqual(result.findings.map(finding => finding.symbol), ['Wrapped', 'default', 'Card']);
  assert.equal(result.metrics.components.length, 3);
});

test('nested helper JSX does not turn an uppercase non-component function into a component', () => {
  const source = `function ServiceFactory() {
  function renderInner() { return <div />; }
  return { render: renderInner };
}`;
  const result = analyzeSource(source, 'sample.tsx', [rule('component-max-lines', { max: 1 })]);
  assert.equal(result.findings.length, 0);
});

test('max parameters excludes the TypeScript this pseudo-parameter and ignores overload signatures', () => {
  const source = `function f(this: Context, a: number, b: number): void;
function f(this: Context, a: number, b: number) { return; }
const g = (one: string) => one;`;
  const result = analyzeSource(source, 'sample.ts', [rule('max-parameters', { max: 1 })]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].metric.value, 2);
  assert.equal(result.metrics.functions.length, 2);
});

test('async Promise executor requires the unshadowed Promise constructor', () => {
  const source = `
new Promise(async resolve => { resolve(1); });
new Promise(resolve => { resolve(2); });
function f(Promise) { return new Promise(async resolve => resolve(3)); }
{ const Promise = Custom; new Promise(async () => {}); }
new Promise(async function(resolve) { resolve(4); });
`;
  const result = analyzeSource(source, 'sample.js', [rule('no-async-promise-executor')]);
  assert.deepEqual(result.findings.map(finding => finding.startLine), [2, 6]);
});

test('require-braces counts loop and branch bodies; else-if itself needs no extra braces', () => {
  const source = `if (a) run(); else if (b) { run(); } else stop();
for (const item of items) use(item);
while (a) { run(); }
do step(); while (a);`;
  const result = analyzeSource(source, 'sample.js', [rule('require-braces')]);
  assert.equal(result.findings.length, 4);
  assert.deepEqual(result.metrics.braces, { braced: 2, unbraced: 4 });
});

test('parse failure cannot produce a deceptively clean analyzed result', () => {
  const result = analyzeSource('export const Broken = ( => <div>;', 'bad.tsx', [rule('no-var')]);
  assert.ok(result.parseErrors.length > 0);
  assert.equal(result.coverage.parsed, false);
  assert.equal(result.findings.length, 0);
  assert.ok(result.parseErrors.every(error => error.line >= 1 && error.column >= 1 && error.message));
  assert.deepEqual(result.metrics.functions, []);
});

test('manual rule is intentionally non-executable and unknown checks fail closed', () => {
  assert.equal(analyzeSource('debugger;', 'sample.js', [rule('manual')]).findings.length, 0);
  assert.throws(() => analyzeSource('const x = 1;', 'sample.js', [rule('run-shell')]), /unknown check kind/);
  assert.throws(() => analyzeSource('const x = 1;', 'sample.js', [rule('function-max-lines', { max: 0 })]), /positive integer/);
  assert.throws(() => analyzeSource('hello', 'sample.vue', []), /Unsupported source extension/);
  assert.ok(SUPPORTED_CHECKS.includes('manual'));
});

test('all supported source extensions parse and debugger finding retains evidence', () => {
  for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'mjs', 'cjs']) {
    const evidence = [{ kind: 'document', path: 'rules.md', line: 3 }];
    const result = analyzeSource('debugger;', `source.${extension}`, [rule('no-debugger', {}, { evidence })]);
    assert.equal(result.findings.length, 1, extension);
    assert.deepEqual(result.findings[0].evidence, evidence);
    assert.equal(result.parseErrors.length, 0);
  }
});

test('resource-management declarations are not confused with var', () => {
  const result = analyzeSource('using resource = open();\nawait using asyncResource = openAsync();', 'source.ts', [rule('no-var')]);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.findings.length, 0);
});
