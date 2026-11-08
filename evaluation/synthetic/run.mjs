import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeSource } from './implementation/src/ast.mjs';
import { discoverConventions, extractDocument, importMr } from './implementation/src/ingest.mjs';
import { approveRule, BEST_PRACTICES } from './implementation/src/rules.mjs';
import { resolveRules } from './implementation/src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const filename = relative => path.join(here, relative);
const read = relative => fs.readFileSync(filename(relative), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (relative, value) => {
  fs.mkdirSync(path.dirname(filename(relative)), { recursive: true });
  fs.writeFileSync(filename(relative), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const resultPath = filename('results.json');
if (fs.existsSync(resultPath)) throw new Error('The baseline results already exist. Preserve them; create a separately labeled follow-up instead of overwriting.');
const manifestBytes = fs.readFileSync(filename('manifest.json'));
const manifest = JSON.parse(manifestBytes);
const verify = entries => entries.filter(entry => sha(fs.readFileSync(filename(entry.path))) !== entry.sha256).map(entry => entry.path);
if (verify([...manifest.inputFiles, ...manifest.implementation]).length) throw new Error('Preregistered source or implementation changed; no evaluation was run.');
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

// Exercise the actual CLI against the same snapshot, including the project-group
// aggregation and the separate by-project profiles. No model/API is involved.
write('runs/learned-catalog.json', { schemaVersion: 1, rules: [] });
write('runs/runtime.config.json', {
  schemaVersion: 1, catalog: 'learned-catalog.json', bestPractices: false,
  scopes: [{ id: 'mixed' }], projects: [
    { id: 'major', root: '../corpora/major', scope: 'mixed' },
    { id: 'minor', root: '../corpora/minor', scope: 'mixed' },
  ],
});
const cliArgs = [filename('implementation/bin/selfreview.mjs'), 'learn', '--config', filename('runs/runtime.config.json'),
  '--scope', 'mixed', '--min-samples', String(manifest.protocol.minSamples), '--threshold', String(manifest.protocol.threshold)];
const cli = spawnSync(process.execPath, cliArgs, { cwd: here, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
write('runs/cli-learn.stdout.json', cli.stdout ?? '');
write('runs/cli-learn.stderr.txt', cli.stderr ?? '');
let cliReport = null;
try { cliReport = JSON.parse(cli.stdout); } catch { /* Preserve failures as results. */ }
const learnedCatalog = JSON.parse(read('runs/learned-catalog.json'));
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
  parseDiagnostics, inputChanges, implementationChanges: verify(manifest.implementation),
};
write('results.json', result);

const label = check => check.kind === 'strict-equality' ? `strict-equality (allowNull=${check.options?.allowNull})` : check.kind;
const table = discovery.map(item => {
  const o = item.result.observations;
  return `| ${item.id} | ${item.result.coverage.filesWithMetrics} | ${o.declarations.const}/${o.declarations.let}/${o.declarations.var} | ${o.equality.strict}/${o.equality.loose}/${o.equality.nullLoose} | ${o.braces.braced}/${o.braces.unbraced} | ${item.result.candidates.map(r => label(r.check)).join('; ') || 'нет'} |`;
}).join('\n');
const text = `# Независимая синтетическая проверка SelfReview

## Результат

**${result.status}.** Проверены ${counts.corpusFiles} файлов в корпусах JS/TS/TSX и ${counts.variantFiles} отдельных контрпримеров. Измерения выполнены после сохранения manifest.json; пороги неизменны: minSamples=5, threshold=0.9. Исходники проверяемой реализации скопированы до запуска в implementation/ и защищены хешами. Исторические результаты не исправляются вместе с последующими изменениями продукта.

| Метрика | Факт |
| --- | --- |
| Правильные численные наблюдения | ${counts.correctObservations}/${counts.expectedObservations} |
| Ожидаемые гипотезы обнаружены | ${counts.matchedExpectedHypotheses}/${counts.expectedHypotheses} |
| Неожиданные / пропущенные гипотезы по заранее объявленному набору | ${counts.unexpectedHypotheses}/${counts.missingHypotheses} |
| Правильные исходы правил в двух скоупах | ${counts.correctScopedOutcomes}/${counts.scopedOutcomes} |
| Проверки React-метрик и сигналов | ${counts.correctUiAssertions}/${counts.uiAssertions} |
| Проверки формулировок документа | ${counts.correctDocumentAssertions}/${counts.documentAssertions} |
| Проверки контекста MR | ${counts.correctMrAssertions}/${counts.mrAssertions} |
| Ручные кандидаты из документа с условиями и MR | ${counts.manualCandidatesFromClausesAndMr} |
| Отдельно перечисленные неподдерживаемые смысловые сценарии | ${counts.manualUnsupportedScenarios} |
| Пройденные качественные контрольные условия | ${counts.qualityProbesMet}/${counts.qualityProbes} |
| Гипотезы автоматически утверждены | ${counts.automaticallyApprovedCandidates} |
| Ошибки разбора / изменённые входные файлы | ${counts.parseErrors}/${inputChanges.length} |

Это авторские сценарии, созданные после ознакомления с API. Это не слепой внешний benchmark и не оценка статистической точности на репозиториях. Числа характеризуют строго указанные исходники и заранее фиксированные ожидания. Повторяющиеся синтаксические возможности внутри файлов не являются независимыми наблюдениями о соглашениях команды.

## Что фактически распознано

Объявления показаны как const/let/var, сравнения как strict/loose/nullLoose, тела управляющих конструкций как braced/unbraced.

| Корпус | Файлы | Объявления | Сравнения | Скобки | Гипотезы |
| --- | --- | --- | --- | --- | --- |
${table}

Современный TS-корпус даёт три ожидаемых кандидата. Nullable-корпус сохраняет вариант allowNull=true: сравнение с null допускается отдельно, а произвольное == 0 — нет. Legacy-корпус правильно посчитан, но обратные договорённости «использовать var», «предпочитать нестрогое сравнение» и «допускать однострочные тела без скобок» генератором не формулируются. Это граница словаря из трёх семейств, а не отсутствие стиля в старом проекте.

## Два существенных пробела исходной реализации

### Условие в заголовке документа теряется

В documents/headings.md запрет console находится под заголовком «Production code only». Импорт создаёт исполняемый no-console с include=["**/*"]. В description и evidence остаётся только «Do not use console.», а условие из заголовка отсутствует. Предзарегистрированный контроль heading-condition-preserved: **${headingPreserved ? 'MET' : 'GAP'}**.

Кандидат не утверждён автоматически, поэтому немедленного применения запрета ко всему проекту нет. Однако человек, просматривающий только предложенное правило и его excerpt, не увидит потерянного условия. Корректное улучшение: сохранять дерево разделов в evidence и оставлять условное правило ручным, пока его применимость явно не определена. Нельзя придумывать пути src/** или test/** из текста заголовка без привязки к проекту.

### Крупный проект может подавить противоположный стиль меньшего

В mixed находятся 10 современных файлов крупного проекта и 5 legacy-файлов малого. Объявления: 200 const и 10 var; сравнения: 50 strict и 5 loose; скобки: 50 braced и 5 unbraced. Агрегированные доли ${(200/210*100).toFixed(2)}%, ${(50/55*100).toFixed(2)}% и ${(50/55*100).toFixed(2)}% проходят неизменный порог 90%.

Генерируются ${mixedCandidates.length} кандидата на общий scope, хотя все соответствующие возможности малого проекта следуют противоположному стилю. Actual CLI сохраняет отдельный профиль minor: **${dissentExplicit ? 'да' : 'нет'}**. Явное предупреждение о minor или сужение применимости гипотез: **${warningNamesMinority || narrowed ? 'да' : 'нет'}**. Предзарегистрированный контроль mixed-scope-hypotheses-qualified: **${warningNamesMinority || narrowed ? 'MET' : 'GAP'}**.

Агрегированные частоты вычислены правильно; эти гипотезы не являются неожиданными относительно порогового алгоритма. Пробел — недостаточная квалификация общей формулировки при противоположном профиле одного из проектов. Это не доказательство общего соглашения. Следующий контроль должен требовать явного предупреждения или отдельного решения о вариантах, а не молча снижать порог или скрывать меньший проект.

## Компоненты: где AST помогает и где не помогает

LargeReport имеет 163 физические строки и одну основную задачу: статически отрисовать отчёт. Сработали ${uiResults.find(item => item.id === 'large').analysis.findings.length} сигнала размера. Они полезны как повод посмотреть на структуру, но не доказывают плохую декомпозицию.

CheckoutHub занимает 11 строк, но соединяет UI, запрос оплаты, чтение токена, запись результата и cookie, навигацию и форматирование. Текущие best practices выдали **${uiResults.find(item => item.id === 'compact').analysis.findings.length}** находок. Это сохранённый смысловой пропуск. Для такой проверки нужен отдельный агентский/человеческий разбор ответственности и границ, а не ещё один порог количества строк.

## Скоупы и контрпримеры

Выполнены ${counts.scopedOutcomes} исхода на одинаковых файлах для strict и compatible. Зафиксированы разные allowNull, допустимые методы console, разрешение substr и порог размера компонента. Проверены не только прямые нарушения: локальный параметр с именем console не считается глобальным console; литеральный console["log"] учитывается; == 0 не маскируется исключением для null.

Сохранены ограничения синтаксического подхода. Динамический console[method] не получает разрешение через анализ значения const. Шаблон *.substr также ловит пользовательский метод substr, хотя это не доказательство устаревшего API. Вызов String.prototype.substr через присвоенный alias остаётся незамеченным. Эти результаты заранее заявлены в manifest и не превращены в «семантическое покрытие».

## Документы и MR

Документ с восемью пунктами дал ${documentResults.clauses.coverage.executableCandidates} исполняемых и ${documentResults.clauses.coverage.manualCandidates} ручных кандидатов. Условие «Never use var, except in generated compatibility shims» в многострочном bullet не было отброшено: правило осталось ручным. Простые формулировки strict equality except null, console except warn и лимит параметров распознаны. Идемпотентность повторной оплаты, независимость domain/UI и разные правила production/tests требуют интерпретации.

MR содержит четыре содержательных комментария и один системный. Новый участок diff, старая сторона, отсутствующий в diff путь и комментарий без привязки различены; resolved/outdated сохранены как контекст. Наличие строки в diff не названо доказанной семантической корректностью: contextVerified остаётся false. Все обнаруженные правила остались кандидатами.

## Воспроизводимость и ограничения вывода

- manifest.json записан до анализа; SHA-256: ${result.manifestSha256}.
- results.json содержит все ожидаемые и фактические значения, а не только успешные строки.
- runs/cli-learn.stdout.json содержит фактический ответ CLI для общего scope; runs/learned-catalog.json — его кандидаты.
- implementation/ — снимок проверенных модулей. Он не меняется при исправлении production.
- Использованы Node ${process.version}, ${process.platform}/${process.arch}, TypeScript parser ${result.runtime.parser}.
- Код проектов не выполнялся; сетевых обращений, API-моделей и пользовательских файлов нет.
- Этот запуск не измеряет экономию времени ревью, качество агентского исправления и эффект в реальных MR. Для этих утверждений необходим отдельный протокол с историческими MR и независимой оценкой.
`;
write('RESULTS.md', text);
console.log(JSON.stringify({ status: result.status, counts, failedChecks: failedChecks.map(item => ({ id: item.id, expected: item.expected, actual: item.actual })), files: ['manifest.json', 'results.json', 'RESULTS.md'] }, null, 2));
process.exitCode = failedChecks.length || counts.parseErrors || cli.status !== 0 ? 1 : 0;
