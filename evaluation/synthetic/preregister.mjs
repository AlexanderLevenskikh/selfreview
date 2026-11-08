import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This script constructs fixtures and freezes expectations. It never invokes
// the analyzer, discovery, importer, rule resolver, or CLI under evaluation.
const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../..');
const manifestPath = path.join(here, 'manifest.json');
if (fs.existsSync(manifestPath)) throw new Error('A preregistration already exists. Preserve it; do not overwrite criteria after observing results.');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (relative, text) => {
  const filename = path.join(here, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, text);
};
const json = (relative, value) => write(relative, JSON.stringify(value, null, 2) + '\n');
const lines = rows => rows.join('\n') + '\n';
const sourceFiles = [];
function source(corpus, filename, rows) {
  const relative = `corpora/${corpus}/${filename}`;
  write(relative, lines(rows));
  sourceFiles.push({ corpus, path: relative, sha256: sha(fs.readFileSync(path.join(here, relative))) });
}

for (let i = 1; i <= 6; i++) {
  source('modern', `normalize-${i}.ts`, [
    `export function normalize${i}(input: number) {`,
    '  const baseline = input;',
    '  let result = baseline;',
    '  if (baseline === 0) {',
    '    result = 1;',
    '  }',
    '  if (baseline !== -1) {',
    '    result += 2;',
    '  }',
    '  return result;',
    '}',
  ]);
  source('nullable', `name-${i}.ts`, [
    `export function normalizeName${i}(value: string | null | undefined, mode: string) {`,
    '  const fallback = "missing";',
    '  if (value == null) {',
    '    return fallback;',
    '  }',
    '  if (mode === "upper") {',
    '    return value.toUpperCase();',
    '  }',
    '  if (mode !== "trim") {',
    '    return value;',
    '  }',
    '  return value.trim();',
    '}',
  ]);
  source('legacy', `legacy-${i}.js`, [
    `export function legacy${i}(input) {`,
    '  var working = input;',
    '  var result = 0;',
    '  if (working == 0) result = 1;',
    '  if (working != 1) result += 2;',
    '  return String(result).substr(0, 3);',
    '}',
  ]);
}
for (let i = 1; i <= 10; i++) {
  source('major', `modern-${i}.ts`, [
    `export function major${i}(input: number) {`,
    ...Array.from({ length: 20 }, (_, n) => `  const item${n} = input + ${n};`),
    ...Array.from({ length: 5 }, (_, n) => `  if (item0 === ${n}) { return item${n + 1}; }`),
    '  return item19;',
    '}',
  ]);
}
for (let i = 1; i <= 5; i++) {
  source('minor', `compat-${i}.js`, [
    `export function minor${i}(input) {`,
    '  var code = input;',
    '  var result = 0;',
    '  if (code == 0) result = 1;',
    '  return result;',
    '}',
  ]);
}
source('ui', 'LargeReport.tsx', [
  'export function LargeReport() {',
  '  const title = "One responsibility: render a static report";',
  '  return (',
  '    <section aria-label={title}>',
  ...Array.from({ length: 156 }, (_, n) => `      <div>Report row ${n + 1}</div>`),
  '    </section>',
  '  );',
  '}',
]);
source('ui', 'CheckoutHub.tsx', [
  'export function CheckoutHub({ user, total }: { user: string; total: number }) {',
  '  const token = localStorage.getItem("token");',
  '  const onClick = async () => {',
  '    const receipt = await fetch("/billing", { method: "POST", body: JSON.stringify({ user, total, token }) });',
  '    localStorage.setItem("lastReceipt", await receipt.text());',
  '    document.cookie = "checkout=complete";',
  '    window.location.assign("/receipt");',
  '  };',
  '  const formatted = new Intl.NumberFormat("en").format(total);',
  '  return <button onClick={onClick}>Pay {formatted}</button>;',
  '}',
]);

const variants = [
  { id: 'null-guard', file: 'null-guard.ts', source: 'export const absent = (x: unknown) => x == null;\n', strict: ['strict-equality'], compatible: [] },
  { id: 'non-null-loose', file: 'non-null-loose.ts', source: 'export const same = (x: unknown) => x == 0;\n', strict: ['strict-equality'], compatible: ['strict-equality'] },
  { id: 'strict-guard', file: 'strict-guard.ts', source: 'export const same = (x: unknown) => x === 0;\n', strict: [], compatible: [] },
  { id: 'console-log', file: 'console-log.ts', source: 'console.log("audit");\n', strict: ['no-console'], compatible: [] },
  { id: 'console-warn', file: 'console-warn.ts', source: 'console.warn("audit");\n', strict: [], compatible: [] },
  { id: 'shadowed-console', file: 'shadowed-console.ts', source: 'export function fake(console: { log(s: string): void }) { console.log("local"); }\n', strict: [], compatible: [] },
  { id: 'literal-console-member', file: 'literal-console-member.ts', source: 'console["log"]("audit");\n', strict: ['no-console'], compatible: [] },
  { id: 'dynamic-console-member', file: 'dynamic-console-member.ts', source: 'const method = "log"; console[method]("audit");\n', strict: ['no-console'], compatible: ['no-console'], limitation: 'Constant propagation is not performed; dynamic membership cannot prove an allowed member.' },
  { id: 'string-substr', file: 'string-substr.ts', source: 'export const prefix = (text: string) => text.substr(0, 3);\n', strict: ['restricted-call'], compatible: [] },
  { id: 'user-method-substr', file: 'user-method-substr.ts', source: 'const own = { substr(n: number) { return n; } }; own.substr(1);\n', strict: ['restricted-call'], compatible: [], limitation: 'The configured wildcard also flags an unrelated method; it is not type-aware deprecation evidence.' },
  { id: 'aliased-substr', file: 'aliased-substr.ts', source: 'const old = String.prototype.substr; export const prefix = old.call("value", 0, 3);\n', strict: [], compatible: [], limitation: 'The same legacy API through an alias is outside this syntax matcher.' },
  { id: 'component-variant', file: 'VariantCard.tsx', source: lines([
    'export function VariantCard() {', '  return (', '    <article>',
    '      <span>One</span>', '      <span>Two</span>', '      <span>Three</span>',
    '      <span>Four</span>', '      <span>Five</span>', '      <span>Six</span>',
    '    </article>', '  );', '}',
  ]), strict: ['component-max-lines'], compatible: [] },
];
for (const item of variants) write(`variants/${item.file}`, item.source);

write('documents/clauses.md', lines([
  '# Synthetic agreements', '',
  '- Use strict equality except null.',
  '- Never use var',
  '  except in generated compatibility shims.',
  '- Do not use console except warn.',
  '- Functions must have at most 4 parameters.',
  '- Components should have a single reason to change.',
  '- When retrying a payment request, reuse the idempotency key across attempts.',
  '- Keep domain calculations independent from UI components.',
  '- В тестах допустим console.log, в production коде запрещён.',
]));
write('documents/headings.md', lines([
  '# Synthetic agreements', '',
  '## Production code only', '',
  '- Do not use console.', '',
  '## Unit tests', '',
  '- Console logging is permitted for diagnostics.',
]));

const mr = {
  title: 'Synthetic discussion; a suggestion is not a project-wide agreement',
  diff: 'diff --git a/src/counter.ts b/src/counter.ts\n--- a/src/counter.ts\n+++ b/src/counter.ts\n@@ -1 +1 @@\n-var count = 1;\n+const count = 1;\n',
  comments: [
    { id: 'new-1', body: 'Never use var.', position: { new_path: 'src/counter.ts', new_line: 1 }, author: 'synthetic-reviewer', resolved: true },
    { id: 'old-2', body: 'Use strict equality except null.', position: { old_path: 'src/counter.ts', old_line: 1 }, side: 'old', outdated: true },
    { id: 'absent-3', body: 'Please separate request handling from rendering in this component.', path: 'src/CheckoutHub.tsx', line: 99 },
    { id: 'general-4', body: 'Do not use console except warn.' },
    { id: 'system-5', body: 'Never use var.', system: true },
  ],
};
json('documents/mr.json', mr);

const basePolicy = {
  strict: [
    { kind: 'strict-equality', options: { allowNull: false } },
    { kind: 'no-console', options: { allowMethods: ['warn'] } },
    { kind: 'restricted-call', options: { callees: ['document.write', '*.substr'] } },
    { kind: 'component-max-lines', options: { max: 8 } },
  ],
  compatible: [
    { kind: 'strict-equality', options: { allowNull: true } },
    { kind: 'no-console', options: { allowMethods: ['log', 'warn'] } },
    { kind: 'restricted-call', options: { callees: ['document.write'] } },
    { kind: 'component-max-lines', options: { max: 20 } },
  ],
};
json('synthetic-policy.json', basePolicy);

function expectedFacts(files, declarations, equality, braces, fnCount, min, max) {
  return {
    'coverage.filesWithMetrics': files,
    'observations.declarations.const': declarations[0],
    'observations.declarations.let': declarations[1],
    'observations.declarations.var': declarations[2],
    'observations.equality.strict': equality[0],
    'observations.equality.loose': equality[1],
    'observations.equality.nullLoose': equality[2],
    'observations.braces.braced': braces[0],
    'observations.braces.unbraced': braces[1],
    'observations.functionLines.count': fnCount,
    'observations.functionLines.min': min,
    'observations.functionLines.max': max,
  };
}
const modernHypotheses = [
  { kind: 'no-var', options: {} },
  { kind: 'strict-equality', options: { allowNull: false } },
  { kind: 'require-braces', options: {} },
];
const nullableHypotheses = structuredClone(modernHypotheses);
nullableHypotheses[1].options.allowNull = true;
const discoveryCases = [
  { id: 'modern', corpora: ['modern'], facts: expectedFacts(6, [6,6,0], [12,0,0], [12,0], 6, 11,11), hypotheses: modernHypotheses },
  { id: 'nullable', corpora: ['nullable'], facts: expectedFacts(6, [6,0,0], [12,6,6], [18,0], 6, 13,13), hypotheses: nullableHypotheses },
  { id: 'legacy', corpora: ['legacy'], facts: expectedFacts(6, [0,0,12], [0,12,0], [0,12], 6, 7,7), hypotheses: [] },
  { id: 'major', corpora: ['major'], facts: expectedFacts(10, [200,0,0], [50,0,0], [50,0], 10, 28,28), hypotheses: modernHypotheses },
  { id: 'minor', corpora: ['minor'], facts: expectedFacts(5, [0,0,10], [0,5,0], [0,5], 5, 6,6), hypotheses: [] },
  { id: 'mixed', corpora: ['major','minor'], facts: expectedFacts(15, [200,0,10], [50,5,0], [50,5], 15, 6,28), hypotheses: modernHypotheses },
];

const snapshot = [];
for (const directory of ['src', 'bin']) {
  for (const name of fs.readdirSync(path.join(project, directory)).filter(name => name.endsWith('.mjs')).sort()) {
    const bytes = fs.readFileSync(path.join(project, directory, name));
    const relative = `implementation/${directory}/${name}`;
    write(relative, bytes);
    snapshot.push({ path: relative, originalPath: `${directory}/${name}`, sha256: sha(bytes) });
  }
}
write('implementation/package.json', fs.readFileSync(path.join(project, 'package.json')));
const inputPaths = [
  ...sourceFiles.map(file => file.path),
  ...variants.map(item => `variants/${item.file}`),
  'documents/clauses.md', 'documents/headings.md', 'documents/mr.json', 'synthetic-policy.json',
];
const inputFiles = inputPaths.map(relative => ({ path: relative, sha256: sha(fs.readFileSync(path.join(here, relative))) }));

const manifest = {
  schemaVersion: 1,
  name: 'Independent synthetic characterization; fixed before any analysis run',
  preregisteredAt: new Date().toISOString(),
  protocol: {
    minSamples: 5, threshold: 0.9,
    noProductionEdits: true, noThresholdTuning: true, noNetwork: true,
    noUserFiles: true, noProjectCodeExecution: true,
    qualification: 'Author-constructed held-out-style fixtures, not a random sample, external benchmark, or statistical estimate of real-repository precision/recall.',
    evidenceMeaning: 'Detected frequencies are observations and candidate hypotheses. They are never evidence of team agreement or permission to approve a rule.',
    fixedImplementation: 'Frozen byte-for-byte copy of the production modules before evaluation; current production may later differ.',
  },
  inputFiles, sourceFiles, implementation: snapshot,
  discoveryCases,
  variants: variants.map(({ source, ...rest }) => rest),
  ui: {
    large: { path: 'corpora/ui/LargeReport.tsx', componentLines: 163, expectedFindings: ['component-max-lines', 'function-max-lines'], semanticInterpretation: 'Long static rendering with one main responsibility; size alone does not prove poor decomposition.' },
    compact: { path: 'corpora/ui/CheckoutHub.tsx', componentLines: 11, expectedFindings: [], responsibilitiesForManualReview: ['UI rendering', 'billing network request', 'token access', 'receipt and cookie persistence', 'navigation', 'formatting'] },
  },
  documentExpectations: {
    clauses: { units: 8, executableCandidates: 3, manualCandidates: 5, executableChecks: [
      { kind: 'strict-equality', options: { allowNull: true } },
      { kind: 'no-console', options: { allowMethods: ['warn'] } },
      { kind: 'max-parameters', options: { max: 4 } },
    ], conditionalVarMustStayManual: true },
    headings: { qualityProbe: 'A production-only section must not yield a context-free rule applicable to all files. Retaining a manual rule with heading context is sufficient; no filesystem path must be invented.', expectedContextPreserved: true },
  },
  mrExpectations: {
    comments: 4, systemComments: 1, executableCandidates: 3, manualCandidates: 1,
    contexts: { 'new-1': 'in-diff', 'old-2': 'old-side', 'absent-3': 'not-in-diff', 'general-4': 'unlocated' },
    expectedAutomaticallyApproved: 0, contextVerifiedMustRemainFalse: true,
  },
  qualityProbes: [
    { id: 'heading-condition-preserved', expected: true, meaning: 'The production-only condition survives extraction or forces manual review.' },
    { id: 'mixed-scope-dissent-explicit', expected: true, meaning: 'Opposite per-project observations are exposed by the actual CLI learning report.' },
    { id: 'mixed-scope-hypotheses-qualified', expected: true, meaning: 'Scope-wide aggregate hypotheses carry an explicit warning naming the contradictory minority project, or are narrowed to supported projects. A general caveat about sampling alone is insufficient.' },
    { id: 'candidate-not-approval', expected: true, meaning: 'All imported/discovered rules stay candidates.' },
    { id: 'source-immutability', expected: true, meaning: 'Analysis, importing and learning preserve all fixture source bytes.' },
  ],
  manualUnsupportedScenarios: [
    { id: 'legacy-require-var', reason: 'The current discovery vocabulary cannot propose an inverse require-var convention, despite counted observations.' },
    { id: 'legacy-loose-equality', reason: 'Discovery cannot propose a general prefer-loose-equality convention.' },
    { id: 'legacy-braceless', reason: 'Discovery cannot propose a general braceless convention.' },
    { id: 'long-component-responsibility', reason: 'A 163-line rendering component is a size signal, not proof of multiple responsibilities.' },
    { id: 'compact-component-responsibility', reason: 'The 11-line component mixes multiple responsibilities; no current AST heuristic detects that.' },
    { id: 'receiver-type-deprecation', reason: 'The *.substr matcher also flags a user-defined method with the same name.' },
    { id: 'alias-deprecation', reason: 'Aliasing String.prototype.substr escapes the direct-call matcher.' },
  ],
};
json('manifest.json', manifest);
console.log(JSON.stringify({ manifest: manifestPath, sha256: sha(fs.readFileSync(manifestPath)), corpusFiles: sourceFiles.length, variantFiles: variants.length, observationAssertions: discoveryCases.reduce((n,c) => n + Object.keys(c.facts).length, 0) }, null, 2));
