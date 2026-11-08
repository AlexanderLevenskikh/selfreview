import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeSource } from '../../src/ast.mjs';
import { discoverConventions, extractDocument, importMr } from '../../src/ingest.mjs';
import { approveRule, BEST_PRACTICES } from '../../src/rules.mjs';
import { resolveRules } from '../../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const outputRoot = path.join(here, 'postfix');
const outputPath = relative => path.join(outputRoot, relative);
const filename = relative => path.join(here, relative);
const read = relative => fs.readFileSync(filename(relative), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (relative, value) => {
  fs.mkdirSync(path.dirname(outputPath(relative)), { recursive: true });
  fs.writeFileSync(outputPath(relative), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const resultPath = outputPath('results.json');
if (fs.existsSync(resultPath)) throw new Error('The post-fix results already exist. Preserve them; create another separately labeled follow-up instead of overwriting.');
const manifestBytes = fs.readFileSync(filename('manifest.json'));
const manifest = JSON.parse(manifestBytes);
const verify = entries => entries.filter(entry => sha(fs.readFileSync(filename(entry.path))) !== entry.sha256).map(entry => entry.path);
if (verify([...manifest.inputFiles, ...manifest.implementation]).length) throw new Error('Preregistered source or implementation changed; no evaluation was run.');
const baselineBytes = fs.readFileSync(filename('results.json'));
const baseline = JSON.parse(baselineBytes);
const currentImplementation = [];
for (const directory of ['src', 'bin']) {
  for (const name of fs.readdirSync(path.join(projectRoot, directory)).filter(name => name.endsWith('.mjs')).sort()) {
    const originalPath = `${directory}/${name}`;
    const bytes = fs.readFileSync(path.join(projectRoot, originalPath));
    const relative = `implementation/${originalPath}`;
    fs.mkdirSync(path.dirname(outputPath(relative)), {recursive:true});
    fs.writeFileSync(outputPath(relative), bytes);
    currentImplementation.push({path:relative, originalPath, sha256:sha(bytes)});
  }
}
fs.copyFileSync(path.join(projectRoot, 'package.json'), outputPath('implementation/package.json'));
const currentImplementationChanges = () => currentImplementation.filter(entry => sha(fs.readFileSync(path.join(projectRoot, entry.originalPath))) !== entry.sha256).map(entry => entry.originalPath);
const startedAt = new Date().toISOString();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const checkKey = check => JSON.stringify(stable({ kind: check.kind, options: check.options ?? {} }));
const get = (object, expression) => expression.split('.').reduce((value, key) => value?.[key], object);
const assertion = (id, expected, actual) => ({ id, expected, actual: actual ?? null, correct: same(expected, actual) });

const records = [], parseDiagnostics = [];
for (const file of manifest.sourceFiles) {
  const analysis = analyzeSource(read(file.path), file.path, []);
  records.push({ corpus: file.corpus, path: file.path.replace(/^corpora\//, ''), hash: file.sha256, metrics: analysis.metrics });
  parseDiagnostics.push({ path: file.path, errors: analysis.parseErrors, coverage: analysis.coverage });
}
const discovery = [];
const facts = [], expectedHypotheses = [], unexpectedHypotheses = [], missingHypotheses = [];
const allCandidates = [];
for (const spec of manifest.discoveryCases) {
  const selected = records.filter(record => spec.corpora.includes(record.corpus));
  const result = discoverConventions(selected, { scope: spec.id, minSamples: manifest.protocol.minSamples, threshold: manifest.protocol.threshold });
  allCandidates.push(...result.candidates);
  for (const [property, expected] of Object.entries(spec.facts)) facts.push(assertion(`${spec.id}:${property}`, expected, get(result, property)));
  const expectedKeys = spec.hypotheses.map(checkKey), actualKeys = result.candidates.map(rule => checkKey(rule.check));
  for (const expected of expectedKeys) {
    const value = { corpus: spec.id, check: JSON.parse(expected), observed: actualKeys.includes(expected) };
    expectedHypotheses.push(value);
    if (!value.observed) missingHypotheses.push(value);
  }
  for (const actual of actualKeys) if (!expectedKeys.includes(actual)) unexpectedHypotheses.push({ corpus: spec.id, check: JSON.parse(actual) });
  discovery.push({ id: spec.id, result });
}

const policy = JSON.parse(read('synthetic-policy.json'));
const policyEvidence = { kind: 'synthetic-evaluation-policy', path: 'synthetic-policy.json', sha256: sha(read('synthetic-policy.json')), excerpt: 'Explicitly preregistered synthetic variants, unrelated to any user project.' };
const rules = Object.entries(policy).flatMap(([scope, checks]) => checks.map(check => approveRule({
  id: `${scope}.${check.kind}`, family: check.kind, scope,
  title: `Synthetic ${scope} ${check.kind}`, description: 'A fixed evaluation policy, not an inferred team agreement.',
  status: 'candidate', mode: 'enforce', severity: 'error', check, evidence: [policyEvidence],
}, 'synthetic-evaluation-oracle', 'Apply the explicitly preregistered synthetic policy only.', manifest.preregisteredAt)));
const variantConfig = { scopes: Object.keys(policy).map(id => ({ id })), bestPractices: false };
const scopedOutcomes = [];
for (const variant of manifest.variants) {
  for (const scope of ['strict', 'compatible']) {
    const resolved = resolveRules(variantConfig, { schemaVersion: 1, rules }, scope, variant.file);
    const analysis = analyzeSource(read(`variants/${variant.file}`), variant.file, resolved.rules);
    const actual = analysis.findings.map(finding => finding.family).sort();
    scopedOutcomes.push({
      ...assertion(`${variant.id}:${scope}`, [...variant[scope]].sort(), actual),
      scope, file: variant.file, conflicts: resolved.conflicts, parseErrors: analysis.parseErrors,
      findings: analysis.findings, limitation: variant.limitation ?? null,
    });
  }
}

const uiResults = [], uiAssertions = [];
for (const [id, spec] of Object.entries(manifest.ui)) {
  const analysis = analyzeSource(read(spec.path), spec.path, BEST_PRACTICES);
  const actualChecks = analysis.findings.map(finding => finding.family).sort();
  const componentLines = analysis.metrics.components[0]?.lines;
  uiAssertions.push(assertion(`${id}:component-lines`, spec.componentLines, componentLines));
  uiAssertions.push(assertion(`${id}:findings`, [...spec.expectedFindings].sort(), actualChecks));
  uiResults.push({ id, analysis, interpretation: spec.semanticInterpretation ?? spec.responsibilitiesForManualReview });
}

const documentResults = {};
for (const name of ['clauses', 'headings']) {
  const relative = `documents/${name}.md`;
  documentResults[name] = extractDocument(read(relative), { scope: 'document-evaluation', sourcePath: relative, sourceHash: sha(read(relative)) });
  allCandidates.push(...documentResults[name].candidates);
}
const clausesExpected = manifest.documentExpectations.clauses;
const documentAssertions = ['units', 'executableCandidates', 'manualCandidates'].map(property =>
  assertion(`clauses:${property}`, clausesExpected[property], documentResults.clauses.coverage[property]));
documentAssertions.push(assertion('clauses:executable-checks', clausesExpected.executableChecks.map(checkKey).sort(),
  documentResults.clauses.candidates.filter(r => r.check.kind !== 'manual').map(r => checkKey(r.check)).sort()));
const conditionalVar = documentResults.clauses.candidates.find(r => r.description.startsWith('Never use var'));
documentAssertions.push(assertion('clauses:conditional-var-remains-manual', true,
  conditionalVar?.check.kind === 'manual' && conditionalVar.description.includes('except in generated compatibility shims')));

const mrInput = JSON.parse(read('documents/mr.json'));
const mrResult = importMr(mrInput, { scope: 'mr-evaluation', sourcePath: 'documents/mr.json', sourceHash: sha(read('documents/mr.json')) });
allCandidates.push(...mrResult.candidates);
const mrAssertions = ['comments', 'systemComments', 'executableCandidates', 'manualCandidates'].map(property =>
  assertion(`mr:${property}`, manifest.mrExpectations[property], mrResult.coverage[property]));
for (const [commentId, expected] of Object.entries(manifest.mrExpectations.contexts)) {
  const evidence = mrResult.candidates.flatMap(rule => rule.evidence).find(e => e.commentId === commentId);
  mrAssertions.push(assertion(`mr:context:${commentId}`, expected, evidence?.contextState));
}
mrAssertions.push(assertion('mr:context-not-semantically-verified', true, mrResult.candidates.every(r => r.evidence.every(e => e.contextVerified === false))));

// Exercise the actual current CLI, including the project-group
// aggregation and the separate by-project profiles. No model/API is involved.
write('runs/learned-catalog.json', { schemaVersion: 1, rules: [] });
write('runs/runtime.config.json', {
  schemaVersion: 1, catalog: 'learned-catalog.json', bestPractices: false,
  scopes: [{ id: 'mixed' }], projects: [
    { id: 'major', root: '../../corpora/major', scope: 'mixed' },
    { id: 'minor', root: '../../corpora/minor', scope: 'mixed' },
  ],
});
const cliArgs = [path.join(projectRoot,'bin/selfreview.mjs'), 'learn', '--config', outputPath('runs/runtime.config.json'),
  '--scope', 'mixed', '--min-samples', String(manifest.protocol.minSamples), '--threshold', String(manifest.protocol.threshold)];
const cli = spawnSync(process.execPath, cliArgs, { cwd: here, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
write('runs/cli-learn.stdout.json', cli.stdout ?? '');
write('runs/cli-learn.stderr.txt', cli.stderr ?? '');
let cliReport = null;
try { cliReport = JSON.parse(cli.stdout); } catch { /* Preserve failures as results. */ }
const learnedCatalog = JSON.parse(fs.readFileSync(outputPath('runs/learned-catalog.json'), 'utf8'));
allCandidates.push(...learnedCatalog.rules);
const minority = cliReport?.discovery?.byProject?.find(profile => profile.project === 'minor');
const dissentExplicit = cli.status === 0
  && minority?.observations?.declarations?.var === 10
  && minority?.observations?.equality?.loose === 5
  && minority?.observations?.braces?.unbraced === 5;
const mixedCandidates = learnedCatalog.rules.filter(rule => rule.scope === 'mixed');
const warningText = JSON.stringify(cliReport?.warnings ?? []);
const warningNamesMinority = /minor/i.test(warningText) && /oppos|contrad|mixed|heterogen|different|против|разн/i.test(warningText);
const narrowed = mixedCandidates.length > 0 && mixedCandidates.every(rule =>
  (rule.applicability?.include ?? ['**/*']).some(glob => glob !== '**/*') || (rule.applicability?.exclude?.length ?? 0) > 0);

const productionRule = documentResults.headings.candidates.find(rule => rule.description.includes('Do not use console'));
const relevantContext = productionRule ? JSON.stringify({ description: productionRule.description, evidence: productionRule.evidence }) : '';
const headingNarrowed = productionRule && ((productionRule.applicability?.include ?? ['**/*']).some(glob => glob !== '**/*') || (productionRule.applicability?.exclude?.length ?? 0) > 0);
const headingPreserved = Boolean(productionRule && /Production code only/i.test(relevantContext)
  && (productionRule.check.kind === 'manual' || headingNarrowed));
const automaticApprovals = allCandidates.filter(rule => rule.status !== 'candidate');
const inputChanges = verify(manifest.inputFiles);
const qualityActual = {
  'heading-condition-preserved': headingPreserved,
  'mixed-scope-dissent-explicit': dissentExplicit,
  'mixed-scope-hypotheses-qualified': Boolean(warningNamesMinority || narrowed),
  'candidate-not-approval': automaticApprovals.length === 0,
  'source-immutability': inputChanges.length === 0,
};
const quality = manifest.qualityProbes.map(probe => ({ ...assertion(probe.id, probe.expected, qualityActual[probe.id]), meaning: probe.meaning }));
const aggregateRisk = {
  scope: 'mixed', candidateCount: mixedCandidates.length,
  explicitlyWarnedAboutMinority: warningNamesMinority,
  applicabilityNarrowed: narrowed,
  unqualifiedScopeWideHypotheses: warningNamesMinority || narrowed ? 0 : mixedCandidates.length,
  countWeightedRatios: { noVar: 200 / 210, strictEquality: 50 / 55, requireBraces: 50 / 55 },
  minority: { files: 5, varDeclarations: 10, looseComparisons: 5, unbracedControls: 5 },
  interpretation: 'Aggregate frequencies can meet the threshold while every minority-project opportunity follows the opposite style. Candidates are still unapproved; per-project observations expose dissent, but a scope-wide proposal needs an explicit qualification.',
};

const counts = {
  corpusFiles: manifest.sourceFiles.length,
  variantFiles: manifest.variants.length,
  parseErrors: parseDiagnostics.reduce((n, record) => n + record.errors.length, 0),
  correctObservations: facts.filter(fact => fact.correct).length,
  expectedObservations: facts.length,
  matchedExpectedHypotheses: expectedHypotheses.filter(item => item.observed).length,
  expectedHypotheses: expectedHypotheses.length,
  unexpectedHypotheses: unexpectedHypotheses.length,
  missingHypotheses: missingHypotheses.length,
  correctScopedOutcomes: scopedOutcomes.filter(item => item.correct).length,
  scopedOutcomes: scopedOutcomes.length,
  correctUiAssertions: uiAssertions.filter(item => item.correct).length,
  uiAssertions: uiAssertions.length,
  correctDocumentAssertions: documentAssertions.filter(item => item.correct).length,
  documentAssertions: documentAssertions.length,
  correctMrAssertions: mrAssertions.filter(item => item.correct).length,
  mrAssertions: mrAssertions.length,
  manualCandidatesFromClausesAndMr: documentResults.clauses.coverage.manualCandidates + mrResult.coverage.manualCandidates,
  manualUnsupportedScenarios: manifest.manualUnsupportedScenarios.length,
  automaticallyApprovedCandidates: automaticApprovals.length,
  qualityProbesMet: quality.filter(item => item.correct).length,
  qualityProbes: quality.length,
  unqualifiedAggregateHypotheses: aggregateRisk.unqualifiedScopeWideHypotheses,
};
const failedChecks = [...facts, ...scopedOutcomes, ...uiAssertions, ...documentAssertions, ...mrAssertions, ...quality].filter(check => !check.correct);
const result = {
  schemaVersion: 1, status: failedChecks.length || counts.parseErrors || cli.status !== 0 ? 'COMPLETED_WITH_IDENTIFIED_GAPS' : 'COMPLETED',
  startedAt, finishedAt: new Date().toISOString(), manifestSha256: sha(manifestBytes),
  evaluatorSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, parser: parseDiagnostics[0]?.coverage?.parserVersion },
  thresholds: { minSamples: manifest.protocol.minSamples, threshold: manifest.protocol.threshold },
  qualification: manifest.protocol.qualification,
  counts, failedChecks, facts, discovery, unexpectedHypotheses, missingHypotheses, scopedOutcomes,
  uiAssertions, uiResults, documentAssertions, documentResults, mrAssertions, mrResult,
  quality, aggregateRisk, manualUnsupportedScenarios: manifest.manualUnsupportedScenarios,
  cli: { status: cli.status, signal: cli.signal, error: cli.error?.message ?? null, argv: cliArgs.map(arg => arg.startsWith(here) ? path.relative(here, arg) : arg), report: cliReport, learnedCatalog },
  parseDiagnostics, inputChanges, implementationChanges: currentImplementationChanges(), baselineImplementationChanges: verify(manifest.implementation),
  currentImplementation, baselineResultsSha256: sha(baselineBytes), baselineCounts: baseline.counts,
  originalManifestUnchanged: sha(fs.readFileSync(filename('manifest.json'))) === sha(manifestBytes),
  baselineResultsUnchanged: sha(fs.readFileSync(filename('results.json'))) === sha(baselineBytes),
};
write('results.json', result);

const historyRows = [
  ['Правильные численные наблюдения', 'correctObservations', 'expectedObservations'],
  ['Ожидаемые гипотезы обнаружены', 'matchedExpectedHypotheses', 'expectedHypotheses'],
  ['Правильные исходы в двух скоупах', 'correctScopedOutcomes', 'scopedOutcomes'],
  ['React-метрики и синтаксические сигналы', 'correctUiAssertions', 'uiAssertions'],
  ['Формулировки документа', 'correctDocumentAssertions', 'documentAssertions'],
  ['Контекст MR', 'correctMrAssertions', 'mrAssertions'],
  ['Качественные контрольные условия', 'qualityProbesMet', 'qualityProbes'],
].map(([label,n,d]) => `| ${label} | ${baseline.counts[n]}/${baseline.counts[d]} | ${counts[n]}/${counts[d]} |`).join('\n');
const withheld = cliReport?.withheldCandidates ?? cliReport?.discovery?.withheldCandidates ?? [];
const large = uiResults.find(item => item.id === 'large');
const compact = uiResults.find(item => item.id === 'compact');
const text = `# Повторная проверка после исправлений

## Результат на исходных критериях

**${result.status}.** Проверена текущая реализация src/bin после изменений; историческая проверка сохранена отдельно. Использованы те же 35 файлов в корпусах и 12 файлов контрпримеров, тот же manifest.json и пороги minSamples=5, threshold=0.9. Набор проверок не сокращался. До запуска сохранён отдельный снимок текущих модулей в postfix/implementation/.

| Проверка | Исходный результат | После исправлений |
| --- | --- | --- |
${historyRows}

Неожиданные/пропущенные гипотезы: ${counts.unexpectedHypotheses}/${counts.missingHypotheses}. Автоматически утверждённые кандидаты: ${counts.automaticallyApprovedCandidates}. Ошибки разбора: ${counts.parseErrors}. Изменённые исходные данные: ${inputChanges.length}.

## Сохранение контекста раздела документа

Предзарегистрированное условие: запрет console под заголовком «Production code only» должен сохранять ограничение и не становиться общей исполняемой нормой. При неразрешённой применимости допустим ручной кандидат с контекстом раздела.

- Исторический исход: условие потеряно; исполняемый no-console применяется к **/*.
- Текущий исход проверки: **${headingPreserved ? 'MET' : 'GAP'}**.
- Вид текущего кандидата: **${productionRule?.check?.kind ?? 'не найден'}**.
- Правило остаётся кандидатом; наличие контекста не заменяет подтверждения области действия.

Фактическое содержимое кандидатов и evidence сохранено в results.json → documentResults.headings.

## Противоположные соглашения внутри общего скоупа

Числа не изменены: крупный проект содержит 200 const, 50 строгих сравнений и 50 braced bodies; малый — 10 var, пять нестрогих сравнений и пять unbraced bodies. Агрегированные частоты по-прежнему превышают 90%. Прямой discoverConventions по совокупной выборке по-прежнему даёт три статистически ожидаемых кандидата: это описание выборки.

CLI learn выполняет дополнительное решение по общему scope. Сохранённых кандидатов в общем каталоге теперь **${mixedCandidates.length}**; отдельно сохранённых withheldCandidates: **${Array.isArray(withheld) ? withheld.length : 'см. raw report'}**. Профиль противоположного проекта minor виден: **${dissentExplicit ? 'да' : 'нет'}**. Предзарегистрированный качественный контроль общей формулировки: **${warningNamesMinority || narrowed ? 'MET' : 'GAP'}**.

Различие принципиально: вычисленные частоты не исправлены задним числом и не признаны соглашением команды. Проверяется дополнительная защита от переноса мнения большинства на проект с противоположным наблюдаемым стилем. В raw CLI report сохранены причины отказа и исходные наблюдения.

## Смысловые ограничения остаются

**${counts.manualUnsupportedScenarios}** заранее перечисленных смысловых сценариев остаются отдельным списком manualUnsupportedScenarios. Их нельзя включать в проценты автоматической семантической проверки.

- 163-строчный LargeReport с одной основной обязанностью получает ${large.analysis.findings.length} сигнала размера. Размер не доказывает плохую декомпозицию.
- 11-строчный CheckoutHub совмещает UI, оплату, доступ к токену, сохранение результата, навигацию и форматирование. Он по-прежнему получает **${compact.analysis.findings.length}** замечаний. Это сохранённый пропуск ответственности, а не успешно проверенная архитектура.
- Пользовательский метод substr остаётся совпадением для шаблона *.substr; тип получателя не доказан.
- Алиас String.prototype.substr по-прежнему не обнаруживается прямым синтаксическим matcher.
- Обратные legacy-конвенции require-var, предпочитать loose equality и однострочные тела без скобок не входят в словарь генерации.

## Воспроизводимость

- Изначальный manifest SHA-256: ${result.manifestSha256}.
- Исторический results.json SHA-256: ${result.baselineResultsSha256}.
- Исходный manifest неизменён: ${result.originalManifestUnchanged}; исторические результаты неизменены: ${result.baselineResultsUnchanged}.
- Текущие модули не изменились за время измерения: ${result.implementationChanges.length === 0}.
- Результаты текущего запуска, включая все ожидания и возможные неудачи, находятся в postfix/results.json; снимок реализации — postfix/implementation/; actual CLI stdout и каталог — postfix/runs/.
- Node ${process.version}, ${process.platform}/${process.arch}, TypeScript parser ${result.runtime.parser}.

Сценарии авторские и не образуют внешний слепой benchmark. Проверка не измеряет качество реальных MR, экономию времени сотрудника или готовность произвольного проекта к production. Она демонстрирует конкретные исправления на неизменной выборке при сохранении известных границ.
`;
write('RESULTS.md', text);
console.log(JSON.stringify({status:result.status,counts,failedChecks:failedChecks.map(item=>({id:item.id,expected:item.expected,actual:item.actual})),baselinePreserved:result.originalManifestUnchanged&&result.baselineResultsUnchanged,files:['postfix/results.json','postfix/RESULTS.md']},null,2));
process.exitCode=failedChecks.length||counts.parseErrors||cli.status!==0||result.implementationChanges.length?1:0;
