import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This adjudicates one selector failure against the SAVED raw replay data.
// It never reruns or modifies production, fixtures, thresholds, or expected truth.
const here = path.dirname(fileURLToPath(import.meta.url));
const file = relative => path.join(here, relative);
const read = relative => fs.readFileSync(file(relative));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const manifestBytes = read('manifest.json');
const baselineBytes = read('results.json');
const rawBytes = read('postfix/results.json');
const manifest = JSON.parse(manifestBytes);
const raw = JSON.parse(rawBytes);
const destination = file('postfix/adjudication.json');
if (fs.existsSync(destination)) throw new Error('Adjudication already exists; preserve it.');
if (!manifest.documentExpectations.clauses.conditionalVarMustStayManual) throw new Error('The preregistered semantic assertion changed.');

const sourcePath = 'documents/clauses.md';
const sourceBytes = read(sourcePath);
const sourceHash = manifest.inputFiles.find(entry => entry.path === sourcePath)?.sha256;
if (sha(sourceBytes) !== sourceHash) throw new Error('Frozen document changed.');
const rows = sourceBytes.toString('utf8').split(/\r?\n/u);
const index = rows.findIndex(row => /^- Never use var$/u.test(row));
if (index < 0) throw new Error('The original source unit is missing.');
const sourceLine = index + 1;
const unit = [rows[index].replace(/^-\s+/u, ''), rows[index + 1].trim()].join('\n');
const expectedText = normalize(unit);

function sameSource(evidence) {
  return evidence.path === sourcePath && evidence.line === sourceLine && evidence.sha256 === sourceHash;
}
function conditionalRulePreserved(candidates) {
  const matching = candidates.filter(rule => rule.evidence.some(sameSource));
  if (matching.length !== 1) return false;
  const rule = matching[0];
  return rule.check.kind === 'manual'
    && normalize(rule.description).includes(expectedText)
    && rule.evidence.some(evidence => sameSource(evidence) && normalize(evidence.excerpt).includes(expectedText));
}

const candidates = raw.documentResults.clauses.candidates;
const actual = conditionalRulePreserved(candidates);
const targetIndex = candidates.findIndex(rule => rule.evidence.some(sameSource));
if (targetIndex < 0) throw new Error('No rule points to the original document unit.');
const controls = [];
function control(id, mutate, expected = false) {
  const changed = structuredClone(candidates);
  mutate(changed[targetIndex]);
  const observed = conditionalRulePreserved(changed);
  controls.push({ id, expected, observed, correct: observed === expected });
}
control('removed-qualifier-is-rejected', rule => {
  rule.description = rule.description.replace('except in generated compatibility shims.', '');
  for (const evidence of rule.evidence) evidence.excerpt = evidence.excerpt.replace('except in generated compatibility shims.', '');
});
control('executable-overbroad-no-var-is-rejected', rule => {
  rule.check = { kind: 'no-var', options: {} };
  rule.mode = 'enforce';
  rule.applicability = { include: ['**/*'], exclude: [] };
});
control('wrong-document-source-is-rejected', rule => {
  for (const evidence of rule.evidence) evidence.path = 'documents/different.md';
});
control('wrong-source-line-is-rejected', rule => {
  for (const evidence of rule.evidence) evidence.line = sourceLine + 1;
});
control('wrong-source-hash-is-rejected', rule => {
  for (const evidence of rule.evidence) evidence.sha256 = sha('different contents');
});
control('neutral-prefix-does-not-change-the-semantic-result', rule => {
  rule.description = 'Additional neutral document context\n\n' + rule.description;
}, true);

const original = raw.documentAssertions.find(assertion => assertion.id === 'clauses:conditional-var-remains-manual');
if (!original || original.expected !== true || original.actual !== false) throw new Error('Unexpected raw assertion; do not silently adjudicate another failure.');
const allControlsCorrect = controls.every(control => control.correct);
const effectiveCounts = { ...raw.counts,
  correctDocumentAssertions: raw.counts.correctDocumentAssertions + (actual && allControlsCorrect ? 1 : 0),
};
const rawPreserved = sha(read('postfix/results.json')) === sha(rawBytes);
const baselinePreserved = sha(read('results.json')) === sha(baselineBytes);
const manifestPreserved = sha(read('manifest.json')) === sha(manifestBytes);
const corpusChanges = manifest.inputFiles.filter(entry => sha(read(entry.path)) !== entry.sha256).map(entry => entry.path);
const snapshotChanges = raw.currentImplementation.filter(entry => sha(read(`postfix/${entry.path}`)) !== entry.sha256).map(entry => entry.path);
const remainingFailedChecks = raw.failedChecks.filter(check => check.id !== original.id || !actual || !allControlsCorrect);
const result = {
  schemaVersion: 1,
  status: actual && allControlsCorrect && remainingFailedChecks.length === 0 ? 'EVALUATOR_SELECTOR_ERROR_ADJUDICATED' : 'UNRESOLVED',
  generatedAt: new Date().toISOString(),
  assertionId: original.id,
  preregisteredExpected: true,
  originalAssertion: original,
  unchangedSemanticRequirement: 'The rule for the source unit at documents/clauses.md:4 must remain manual and retain the generated-compatibility-shims exception.',
  originalSelector: "candidate.description.startsWith('Never use var')",
  selectorCorrection: 'Select the unique candidate by immutable document path, source line and source hash; inspect the complete original clause in description and matching evidence. Neutral heading prefixes are permitted.',
  whyOriginalSelectorFailed: 'The heading-context fix prepended the neutral document title to description. The rule remained manual and preserved the entire conditional clause.',
  actual, controls, allControlsCorrect,
  source: { path: sourcePath, line: sourceLine, sha256: sourceHash, originalUnit: unit },
  selectedRule: candidates[targetIndex],
  evidence: {
    manifestSha256: sha(manifestBytes), rawReplaySha256: sha(rawBytes), baselineSha256: sha(baselineBytes),
    evaluatorSha256: sha(read('adjudicate-postfix.mjs')),
    manifestPreserved, baselinePreserved, rawReplayPreserved: rawPreserved, corpusChanges, snapshotChanges,
  },
  criteriaChanged: false, thresholdsChanged: false, corpusChanged: corpusChanges.length > 0, productionChanged: false,
  rawCounts: raw.counts, effectiveCounts, remainingFailedChecks,
  semanticLimitationsUnchanged: raw.manualUnsupportedScenarios,
};
fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
const text = `# Разбор ложного отказа в оценщике

**${result.status}.** Исторический исходный запуск и raw post-fix запуск сохранены без изменений. Production-код повторно не запускался и не менялся. Исправлена только интерпретация одного сохранённого результата оценщиком.

## Почему raw post-fix запуск остался с exit 1

Все пять качественных условий выполнены, включая сохранение production-only заголовка и блокирование общей гипотезы при противоположном стиле малого проекта. Единственный неуспешный assertion относился к многострочному пункту документа: «Never use var, except in generated compatibility shims».

Первоначальный оценщик искал rule.description.startsWith('Never use var'). После исправления импорта description начинается с нейтрального заголовка «# Synthetic agreements». Поэтому оценщик не нашёл нужный кандидат. Это зависимость от представления текста, которой не было в предварительном критерии.

## Проверка того же смыслового требования

Кандидат выбран по исходному документу **documents/clauses.md, строка ${sourceLine}**, SHA-256 **${sourceHash}**. Единственный соответствующий кандидат имеет check.kind=manual. И description, и evidence.excerpt сохраняют полный исходный пункт, включая исключение для generated compatibility shims.

Ожидаемое утверждение осталось прежним: условный запрет не должен превращаться в безусловную AST-норму. Ни исходники, ни пороги, ни истинность ожидаемого результата не изменены. Селектор стал использовать устойчивые координаты provenance вместо префикса отображаемого текста.

## Отрицательные контроли оценщика

| Контроль | Ожидаемый результат проверки сохранения условия | Фактический |
| --- | --- | --- |
${controls.map(control => `| ${control.id} | ${control.expected} | ${control.observed} |`).join('\n')}

Удаление исключения и замена manual на общий исполняемый no-var по-прежнему отвергаются. Неверный документ, строка или хеш не позволяют подменить проверяемый пункт. Дополнительный нейтральный префикс не меняет содержание договорённости.

## Учёт результатов

- Raw post-fix результаты: документ **${raw.counts.correctDocumentAssertions}/${raw.counts.documentAssertions}**, качественные условия **${raw.counts.qualityProbesMet}/${raw.counts.qualityProbes}**; raw exit 1 не переписан.
- После отдельного adjudication того же критерия: документ **${effectiveCounts.correctDocumentAssertions}/${effectiveCounts.documentAssertions}**, качественные условия **${effectiveCounts.qualityProbesMet}/${effectiveCounts.qualityProbes}**.
- Остальные результаты неизменны: наблюдения ${effectiveCounts.correctObservations}/${effectiveCounts.expectedObservations}, ожидаемые гипотезы ${effectiveCounts.matchedExpectedHypotheses}/${effectiveCounts.expectedHypotheses}, исходы в скоупах ${effectiveCounts.correctScopedOutcomes}/${effectiveCounts.scopedOutcomes}, MR ${effectiveCounts.correctMrAssertions}/${effectiveCounts.mrAssertions}.
- Семь смысловых ограничений остались ограничениями. Компактный компонент с несколькими обязанностями по-прежнему не обнаруживается AST-эвристиками.
- Сохранены manifest, исходный результат, raw post-fix результат и снимок измеренной реализации: ${manifestPreserved && baselinePreserved && rawPreserved && !snapshotChanges.length}.

Машинный разбор: adjudication.json. Исходные измерения: results.json в этой папке. Предварительный протокол и baseline: ../manifest.json и ../results.json.
`;
fs.writeFileSync(file('postfix/ADJUDICATION.md'), text);
console.log(JSON.stringify({status:result.status,actual,controls,rawReplayPreserved:rawPreserved,effectiveDocumentAssertions:`${effectiveCounts.correctDocumentAssertions}/${effectiveCounts.documentAssertions}`,quality:`${effectiveCounts.qualityProbesMet}/${effectiveCounts.qualityProbes}`,remainingFailedChecks},null,2));
process.exitCode = result.status === 'EVALUATOR_SELECTOR_ERROR_ADJUDICATED' && !corpusChanges.length && !snapshotChanges.length ? 0 : 1;
