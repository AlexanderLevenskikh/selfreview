import { createHash } from 'node:crypto';
import { parseUnifiedDiff } from './diff.mjs';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 2000;
const MAX_EXCERPT = 1200;
const KINDS = new Set([
  'no-var', 'no-console', 'no-debugger', 'strict-equality', 'restricted-import',
  'restricted-call', 'function-max-lines', 'component-max-lines', 'max-parameters',
  'no-async-promise-executor', 'require-braces', 'manual',
]);
const TITLES = {
  'no-var': 'Не использовать var',
  'no-console': 'Ограничить обращения к console',
  'no-debugger': 'Не оставлять debugger',
  'strict-equality': 'Использовать строгое сравнение',
  'restricted-import': 'Ограничить импорт модуля',
  'restricted-call': 'Ограничить вызов API',
  'function-max-lines': 'Проверять размер функции',
  'component-max-lines': 'Проверять размер компонента',
  'max-parameters': 'Ограничить число параметров',
  'no-async-promise-executor': 'Не передавать async executor в Promise',
  'require-braces': 'Использовать фигурные скобки',
  manual: 'Пункт для ручного ревью',
};

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = value => typeof value === 'string' ? value : '';
const excerpt = value => value.length <= MAX_EXCERPT ? value : `${value.slice(0, MAX_EXCERPT)}…`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) { return hash(JSON.stringify(canonical(value))); }

function validateInput(text, options) {
  if (typeof text !== 'string') throw new TypeError('Import source must be text');
  if (!options || typeof options.scope !== 'string' || !options.scope.trim()) throw new TypeError('An explicit scope is required');
  if (typeof options.sourcePath !== 'string' || !options.sourcePath.trim()) throw new TypeError('A sourcePath is required for provenance');
  if (options.sourceHash !== undefined && !/^[a-f0-9]{64}$/u.test(options.sourceHash)) throw new TypeError('sourceHash must be a SHA-256 hex digest');
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new RangeError('Import source exceeds the 4 MiB limit');
}

function familyFor(check, description) {
  if (check.kind === 'restricted-import' && check.options?.modules?.length === 1) return `${check.kind}:${check.options.modules[0]}`;
  if (check.kind === 'restricted-call' && check.options?.callees?.length === 1) return `${check.kind}:${check.options.callees[0]}`;
  if (check.kind === 'manual') return `manual:${hash(description).slice(0, 16)}`;
  return check.kind;
}

function candidate(check, description, options, evidence, custom = {}) {
  const scopeSlug = options.scope.replace(/[^a-z0-9._-]/gu, '-').replace(/-+/gu, '-').slice(0, 48) || 'scope';
  const kindSlug = textOf(check.kind).replace(/[^a-z0-9-]/gu, '-').slice(0, 32) || 'unknown';
  const applicability = custom.applicability ?? { include: ['**/*'], exclude: [] };
  const digest = fingerprint({ scope: options.scope, check, description, applicability, evidence });
  const rule = {
    id: `candidate-${scopeSlug}-${kindSlug}-${digest.slice(0, 12)}`,
    family: typeof custom.family === 'string' ? custom.family : familyFor(check, description),
    title: typeof custom.title === 'string' && custom.title.trim() ? custom.title : TITLES[check.kind] ?? `Проверка ${check.kind}`,
    description,
    scope: options.scope,
    status: 'candidate',
    severity: custom.severity ?? (check.kind === 'manual' ? 'info' : 'error'),
    mode: custom.mode ?? (check.kind === 'manual' ? 'advisory' : 'enforce'),
    check,
    applicability,
    evidence,
    rationale: typeof custom.rationale === 'string' ? custom.rationale : 'Наблюдение из источника; требуется явное подтверждение применимости и формулировки.',
  };
  if (typeof custom.confidence === 'number') rule.confidence = custom.confidence;
  if (custom.overrides !== undefined) rule.overrides = custom.overrides;
  if (custom.overrideReason !== undefined) rule.overrideReason = custom.overrideReason;
  if (custom.examples !== undefined) rule.examples = custom.examples;
  return rule;
}

function cleanedUnit(value) {
  return value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '').trim();
}

/** Recognize only bounded RU/EN templates. Unknown qualifications stay manual. */
function proseCheck(value) {
  const original = cleanedUnit(value);
  const normal = original.replace(/`|\*\*|__/gu, '').replace(/[.!;]+$/u, '').replace(/\s+/gu, ' ').trim();
  const lower = normal.toLowerCase();
  let match;
  if (/^(?:no var|(?:never|do not|don't|avoid) (?:use|using) (?:the )?var(?: declarations)?|не (?:использовать|используйте|используем|используй|применять|применяйте) var|var (?:is )?(?:forbidden|prohibited|disallowed|запрещ[её]н))$/u.test(lower)
    || /^(?:use (?:const (?:or|and) let|let (?:or|and) const) instead of var|(?:использовать|используйте|используем) (?:const (?:или|и) let|let (?:или|и) const) вместо var)$/u.test(lower)) return { kind: 'no-var', options: {} };

  if (/^(?:no debugger|(?:never|do not|don't) (?:use|leave) (?:a )?debugger(?: statements?)?|не (?:использовать|используйте|оставлять|оставляйте) debugger|debugger (?:is )?(?:forbidden|запрещ[её]н))$/u.test(lower)) return { kind: 'no-debugger', options: {} };

  match = /^(?:(?:never|do not|don't) use console(?:\.\*)?|no console|не (?:использовать|используйте|используем) console(?:\.\*)?)(?:[ ,;]*(?:except|кроме) ([a-z ,]+))?$/u.exec(lower);
  if (match) {
    const allowMethods = match[1] ? match[1].split(/\s*(?:,|\band\b|\bor\b|\bи\b|\s+)\s*/u).filter(Boolean) : [];
    if (allowMethods.every(method => /^[a-z][a-z0-9]*$/u.test(method))) return { kind: 'no-console', options: { allowMethods } };
  }

  const strictPrefix = /^(?:(?:always )?(?:use|prefer) (?:strict equality|strict equality comparisons|=== ?(?:and|\/|,) ?!==|===)|(?:использовать|используйте|используем) (?:строгое сравнение|строгие сравнения|=== ?(?:и|\/|,) ?!==|===)|(?:do not|don't) use ==(?: ?(?:or|and|\/) ?!=)?|не (?:использовать|используйте) ==(?: ?(?:и|или|\/) ?!=)?)(.*)$/u.exec(lower);
  if (strictPrefix) {
    const tail = strictPrefix[1].trim().replace(/^[,;]\s*/u, '');
    if (!tail) return { kind: 'strict-equality', options: { allowNull: false } };
    if (/^(?:except (?:for )?(?:comparisons (?:with|to) )?null|except == null|кроме (?:сравнения с )?null|кроме == null)$/u.test(tail)) return { kind: 'strict-equality', options: { allowNull: true } };
  }

  if (/^(?:(?:always )?use (?:curly )?braces(?: for (?:all )?(?:control statements|if statements|if\/for\/while))?|всегда (?:использовать|используйте|используем) фигурные скобки(?: в (?:условиях и циклах|if\/for\/while))?)$/u.test(lower)) return { kind: 'require-braces', options: {} };

  if (/^(?:(?:do not|don't|never) use async (?:promise executors|executors (?:in|for) promise)|не (?:использовать|используйте) async (?:executor|executors|исполнитель) (?:в|для) promise)$/u.test(lower)) return { kind: 'no-async-promise-executor', options: {} };

  match = /^(?:(react )?(components?|functions?) (?:must |should )?(?:be |have )?(?:at most|no more than|maximum|max|<=) (\d+) (?:physical )?lines|(?:компонент(?:ы|ов)?|функци(?:я|и|й)) (?:не длиннее|не более|максимум|до) (\d+) строк)$/u.exec(lower);
  if (match) {
    const component = /component|компонент/u.test(lower);
    return { kind: component ? 'component-max-lines' : 'function-max-lines', options: { max: Number(match[3] ?? match[4]) } };
  }
  match = /^(?:максимальная длина (компонента|функции)\s*[-—:=]?\s*(\d+) строк|(?:component|function) max(?:imum)? lines\s*[:=]\s*(\d+))$/u.exec(lower);
  if (match) return { kind: /component|компонент/u.test(lower) ? 'component-max-lines' : 'function-max-lines', options: { max: Number(match[2] ?? match[3]) } };

  match = /^(?:(?:functions? (?:must |should )?have )?(?:at most|no more than|maximum|max) (\d+) parameters|(?:у функции )?не более (\d+) параметров(?: у функции)?)$/u.exec(lower);
  if (match) return { kind: 'max-parameters', options: { max: Number(match[1] ?? match[2]) } };

  // Quoted targets are kept case-sensitive; names are never invented from prose.
  match = /^(?:(?:do not|don't|never) import(?: from)?|не (?:импортировать|импортируйте)(?: из)?)\s+([`'"])([^`'"\r\n]+)\1[.!;]?$/iu.exec(original);
  if (match) return { kind: 'restricted-import', options: { modules: [match[2]] } };
  match = /^(?:(?:do not|don't|never) (?:call|use)|не (?:вызывать|вызывайте|использовать|используйте))\s+[`'"]?((?:[A-Za-z_$][\w$]*|\*)(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(\))?[`'"]?[.!;]?$/iu.exec(original);
  if (match && !['var', 'console', 'debugger'].includes(match[1])) return { kind: 'restricted-call', options: { callees: [match[1]] } };
  return null;
}

function extractText(text, options) {
  validateInput(text, options);
  const candidates = [];
  const unmapped = [];
  const warnings = [];
  const sourceHash = typeof options.sourceHash === 'string' ? options.sourceHash : hash(text);
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const coverage = { units: 0, ignoredHeadings: 0, ignoredCodeBlocks: 0, structuredBlocks: 0, sourceBytes: Buffer.byteLength(text, 'utf8'), complete: true };
  const evidenceFor = (content, line) => {
    const result = { kind: options.evidenceKind ?? 'document', path: options.sourcePath, excerpt: excerpt(content), sha256: sourceHash };
    if (options.evidenceKind !== 'mr') result.line = line;
    if (content.length > MAX_EXCERPT) result.excerptTruncated = true;
    return { ...result, ...(options.evidenceContext ?? {}) };
  };
  function addRule(check, description, line, custom = {}) {
    coverage.units += 1;
    if (candidates.length >= MAX_CANDIDATES) {
      if (coverage.complete) warnings.push('Candidate limit reached; the source was not fully imported');
      coverage.complete = false;
      return;
    }
    const evidence = evidenceFor(custom.sourceExcerpt ?? description, line);
    const result = candidate(check, description, options, [evidence], custom);
    candidates.push(result);
    if (check.kind === 'manual') unmapped.push({ ruleId: result.id, reason: 'MANUAL_REVIEW_REQUIRED', ...evidence });
  }
  function addProse(content, line) {
    const value = cleanedUnit(content);
    if (!value) return;
    const check = proseCheck(value);
    addRule(check ?? { kind: 'manual', options: {} }, value, line,
      check ? {} : { title: value.replace(/\s+/gu, ' ').slice(0, 120) });
  }

  let paragraph = [];
  let paragraphLine = 1;
  function flushParagraph() {
    if (paragraph.length) addProse(paragraph.join('\n'), paragraphLine);
    paragraph = [];
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenced = /^\s{0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
    if (fenced) {
      flushParagraph();
      const blockLine = index + 1;
      const isRule = fenced[1][0] === '`' && fenced[2].trim() === 'selfreview-rule';
      const contents = [];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        const end = /^\s{0,3}(`{3,}|~{3,})\s*$/u.exec(lines[index]);
        if (end && end[1][0] === fenced[1][0] && end[1].length >= fenced[1].length) { closed = true; break; }
        contents.push(lines[index]);
      }
      if (!closed) { warnings.push(`Unclosed code fence at source line ${blockLine}`); coverage.complete = false; }
      if (!isRule) { coverage.ignoredCodeBlocks += 1; continue; }
      coverage.structuredBlocks += 1;
      const block = contents.join('\n');
      try {
        const parsed = JSON.parse(block);
        const entries = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.rules) ? parsed.rules : [parsed];
        for (const entry of entries) {
          if (!object(entry) || !object(entry.check) || typeof entry.check.kind !== 'string') {
            warnings.push(`Structured rule at source line ${blockLine} has no check.kind; retained for manual review`);
            coverage.complete = false;
            addRule({ kind: 'manual', options: {} }, block, blockLine, { title: 'Некорректная структурированная договорённость' });
            continue;
          }
          // Keep declarative checker data for strict schema validation by the catalog.
          // Never accept status, approval, scope, id, or claimed provenance from the source.
          const check = structuredClone(entry.check);
          if (!KINDS.has(check.kind)) warnings.push(`Unknown check kind ${check.kind} at source line ${blockLine}; catalog validation is required`);
          const allowed = ['title', 'family', 'severity', 'mode', 'rationale', 'applicability', 'overrides', 'overrideReason', 'examples'];
          const custom = Object.fromEntries(allowed.filter(key => Object.hasOwn(entry, key)).map(key => [key, structuredClone(entry[key])]));
          const description = typeof entry.description === 'string' ? entry.description : typeof entry.title === 'string' ? entry.title : `Структурированное правило ${check.kind}`;
          addRule(check, description, blockLine, { ...custom, sourceExcerpt: block });
        }
      } catch (error) {
        warnings.push(`Invalid JSON in selfreview-rule block at source line ${blockLine}: ${error.message}`);
        coverage.complete = false;
        addRule({ kind: 'manual', options: {} }, block, blockLine, { title: 'Неразобранная структурированная договорённость' });
      }
      continue;
    }
    if (/^\s*#{1,6}\s/u.test(line) || /^\s*(?:---+|===+)\s*$/u.test(line)) {
      flushParagraph();
      coverage.ignoredHeadings += 1;
      continue;
    }
    if (!line.trim()) { flushParagraph(); continue; }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)) {
      flushParagraph();
      // Continuation lines are part of the bullet so conditions are not lost.
      paragraph = [cleanedUnit(line)];
      paragraphLine = index + 1;
      continue;
    }
    if (!paragraph.length) paragraphLine = index + 1;
    paragraph.push(line.trim());
  }
  flushParagraph();
  Object.assign(coverage, {
    candidates: candidates.length,
    executableCandidates: candidates.filter(rule => rule.check.kind !== 'manual').length,
    manualCandidates: candidates.filter(rule => rule.check.kind === 'manual').length,
  });
  return { candidates, unmapped, warnings, coverage };
}

/** Import Markdown/plain text. Machine-readable rules use a selfreview-rule fence. */
export function extractDocument(text, options) { return extractText(text, options); }

function collectComments(data) {
  const comments = [];
  let systemComments = 0;
  let invalidComments = 0;
  function add(entry, discussionId) {
    if (!object(entry)) { invalidComments += 1; return; }
    if (entry.system === true) { systemComments += 1; return; }
    if (Array.isArray(entry.notes)) {
      for (const note of entry.notes) add(note, entry.id ?? discussionId);
      return;
    }
    const body = textOf(entry.body) || textOf(entry.text);
    if (!body.trim()) { invalidComments += 1; return; }
    const position = object(entry.position) ? entry.position : {};
    const newLine = Number.isSafeInteger(position.new_line) && position.new_line > 0 ? position.new_line : null;
    const oldLine = Number.isSafeInteger(position.old_line) && position.old_line > 0 ? position.old_line : null;
    const directLine = Number.isSafeInteger(entry.line) && entry.line > 0 ? entry.line : null;
    let side = ['old', 'LEFT', 'left'].includes(entry.side) ? 'old' : ['new', 'RIGHT', 'right'].includes(entry.side) ? 'new' : null;
    if (!side && newLine) side = 'new';
    if (!side && oldLine) side = 'old';
    const targetLine = directLine ?? (side === 'old' ? oldLine : newLine);
    const targetPath = textOf(entry.path) || textOf(side === 'old' ? position.old_path : position.new_path) || textOf(position.new_path) || textOf(position.old_path);
    const context = { commentIndex: comments.length + 1, contextVerified: false };
    if (entry.id !== undefined && ['string', 'number'].includes(typeof entry.id)) context.commentId = entry.id;
    if (discussionId !== undefined && ['string', 'number'].includes(typeof discussionId)) context.discussionId = discussionId;
    if (targetPath) context.targetPath = targetPath;
    if (targetLine) context.targetLine = targetLine;
    if (side) context.side = side;
    if (typeof entry.resolved === 'boolean') context.resolved = entry.resolved;
    if (typeof entry.outdated === 'boolean') context.outdated = entry.outdated;
    const author = typeof entry.author === 'string' ? entry.author : textOf(entry.author?.username) || textOf(entry.author?.name) || textOf(entry.user?.login);
    if (author) context.author = author;
    comments.push({ body, context });
  }
  if (Array.isArray(data)) for (const entry of data) add(entry);
  else if (object(data)) {
    const list = Array.isArray(data.comments) ? data.comments : Array.isArray(data.discussions) ? data.discussions : Array.isArray(data.notes) ? data.notes : null;
    if (list) for (const entry of list) add(entry);
    else if (typeof data.body === 'string') add(data);
  }
  return { comments, systemComments, invalidComments };
}

/** Import neutral review JSON, GitLab discussions, or raw reviewer text. */
export function importMr(data, options) {
  const inputText = typeof data === 'string' ? data : JSON.stringify(data);
  validateInput(inputText, options);
  const sourceHash = typeof options.sourceHash === 'string' ? options.sourceHash : hash(inputText);
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); }
    catch {
      if (/^(?:diff --git |--- )/mu.test(data)) parsed = { diff: data, comments: [] };
      else parsed = { comments: [{ body: data }] };
    }
  }
  if (!object(parsed) && !Array.isArray(parsed)) throw new TypeError('MR input must contain an object, comment array, or reviewer text');
  const { comments, systemComments, invalidComments } = collectComments(parsed);
  const diffText = object(parsed) && typeof parsed.diff === 'string' ? parsed.diff : null;
  const diff = diffText === null ? null : parseUnifiedDiff(diffText);
  const metadata = {};
  if (object(parsed) && typeof parsed.title === 'string') metadata.title = parsed.title;
  if (object(parsed) && typeof parsed.web_url === 'string') metadata.url = parsed.web_url;
  const candidates = [];
  const unmapped = [];
  const warnings = [];
  let complete = invalidComments === 0;
  if (invalidComments) warnings.push(`${invalidComments} comment entries had no supported body and were not imported`);
  if (diff?.errors.length) { warnings.push(...diff.errors.map(error => `Diff context: ${error}`)); complete = false; }
  if (diff) warnings.push(...diff.warnings);
  if (diffText !== null && !comments.length) warnings.push('A diff alone does not establish a convention; no rule was inferred from changed lines');
  if (!comments.length && diffText === null) { warnings.push('No reviewer comments were found'); complete = false; }
  let units = 0;
  for (const { body, context } of comments) {
    const evidenceContext = { ...context };
    if (diffText !== null) evidenceContext.diffSha256 = hash(diffText);
    if (metadata.title) evidenceContext.mrTitle = metadata.title;
    if (context.side === 'old') evidenceContext.contextState = 'old-side';
    else if (diff && context.targetPath && context.targetLine) {
      const file = diff.files.find(file => file.newPath === context.targetPath);
      const content = file?.newLineContent.find(line => line.line === context.targetLine);
      evidenceContext.contextState = content ? 'in-diff' : 'not-in-diff';
      if (content) evidenceContext.diffLine = excerpt(content.text);
    } else evidenceContext.contextState = diff ? 'unlocated' : 'no-diff';
    const result = extractText(body, { ...options, sourceHash, evidenceKind: 'mr', evidenceContext });
    candidates.push(...result.candidates);
    unmapped.push(...result.unmapped);
    warnings.push(...result.warnings);
    units += result.coverage.units;
    complete = complete && result.coverage.complete;
    if (candidates.length > MAX_CANDIDATES) {
      candidates.length = MAX_CANDIDATES;
      warnings.push('MR candidate limit reached; remaining comments were not fully imported');
      complete = false;
      break;
    }
  }
  const ids = new Set(candidates.map(rule => rule.id));
  return {
    candidates,
    unmapped: unmapped.filter(item => ids.has(item.ruleId)),
    warnings,
    diff,
    metadata,
    coverage: { comments: comments.length, systemComments, invalidComments, units, candidates: candidates.length, executableCandidates: candidates.filter(rule => rule.check.kind !== 'manual').length, manualCandidates: candidates.filter(rule => rule.check.kind === 'manual').length, sourceBytes: Buffer.byteLength(inputText, 'utf8'), complete },
  };
}

function distribution(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor((sorted.length - 1) / 2)], p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], max: sorted.at(-1) };
}

/**
 * Mine a bounded vocabulary of observations. Frequencies are evidence, never
 * approval; distributions are reported rather than invented architectural limits.
 */
export function discoverConventions(records, { scope, minSamples = 5, threshold = 0.9 } = {}) {
  if (!Array.isArray(records)) throw new TypeError('Discovery records must be an array');
  if (typeof scope !== 'string' || !scope.trim()) throw new TypeError('Discovery requires an explicit scope');
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new RangeError('minSamples must be a positive integer');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new RangeError('threshold must be in (0, 1]');
  const candidates = [];
  const warnings = [];
  const valid = records.filter(record => object(record) && typeof record.path === 'string' && /^[a-f0-9]{64}$/u.test(record.hash) && object(record.metrics));
  if (valid.length !== records.length) warnings.push(`${records.length - valid.length} records lacked AST metrics or a source SHA-256 digest`);
  const total = { const: 0, let: 0, var: 0, strict: 0, loose: 0, nullLoose: 0, braced: 0, unbraced: 0 };
  const functions = [];
  const imports = new Map();
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  for (const record of valid) {
    const metrics = record.metrics;
    for (const key of ['const', 'let', 'var']) total[key] += count(metrics.declarations?.[key]);
    for (const key of ['strict', 'loose', 'nullLoose']) total[key] += count(metrics.equality?.[key]);
    for (const key of ['braced', 'unbraced']) total[key] += count(metrics.braces?.[key]);
    if (Array.isArray(metrics.functions)) functions.push(...metrics.functions.filter(fn => object(fn) && Number.isFinite(fn.lines) && fn.lines >= 0));
    if (Array.isArray(metrics.imports)) for (const entry of metrics.imports) {
      if (typeof entry.module === 'string') imports.set(entry.module, (imports.get(entry.module) ?? 0) + 1);
    }
  }
  const options = { scope, sourcePath: 'ast-observations' };
  function propose(check, ratio, selected, description) {
    const evidence = selected.slice(0, 20).map(record => ({
      kind: 'code', path: record.path, sha256: textOf(record.hash),
      excerpt: excerpt(`AST observation: ${JSON.stringify({ declarations: record.metrics.declarations, equality: record.metrics.equality, braces: record.metrics.braces })}`),
    }));
    const digest = fingerprint(selected.map(record => ({ path: record.path, hash: record.hash, metrics: record.metrics })).sort((a, b) => a.path.localeCompare(b.path)));
    const result = candidate(check, description, options, evidence, {
      confidence: ratio,
      rationale: 'Частота в существующем коде описывает выборку, а не обязательную договорённость. Проверьте исключения и подтвердите правило отдельно.',
    });
    // Include the full observation set in the identity, even when displayed evidence is bounded.
    result.id = result.id.replace(/[0-9a-f]{12}$/u, digest.slice(0, 12));
    result.observations = { minSamples, threshold, ratio, files: selected.length, evidenceFilesShown: evidence.length, datasetSha256: digest };
    candidates.push(result);
  }
  const declarations = total.const + total.let + total.var;
  if (declarations >= minSamples && (total.const + total.let) / declarations >= threshold) {
    propose({ kind: 'no-var', options: {} }, (total.const + total.let) / declarations,
      valid.filter(record => count(record.metrics.declarations?.const) + count(record.metrics.declarations?.let) + count(record.metrics.declarations?.var) > 0),
      `В выборке ${total.const + total.let} из ${declarations} объявлений используют const/let; это кандидат на запрет var.`);
  }
  const comparisons = total.strict + total.loose;
  const nonNullComparisons = comparisons - total.nullLoose;
  if (total.strict >= minSamples && nonNullComparisons > 0 && total.strict / nonNullComparisons >= threshold) {
    const allowNull = total.nullLoose > 0;
    propose({ kind: 'strict-equality', options: { allowNull } }, (total.strict + total.nullLoose) / comparisons,
      valid.filter(record => count(record.metrics.equality?.strict) + count(record.metrics.equality?.loose) > 0),
      `В выборке ${total.strict} строгих сравнений, ${total.loose} нестрогих (${total.nullLoose} с null). Вариант allowNull=${allowNull} требует подтверждения.`);
  }
  const controls = total.braced + total.unbraced;
  if (controls >= minSamples && total.braced / controls >= threshold) {
    propose({ kind: 'require-braces', options: {} }, total.braced / controls,
      valid.filter(record => count(record.metrics.braces?.braced) + count(record.metrics.braces?.unbraced) > 0),
      `В выборке ${total.braced} из ${controls} тел управляющих конструкций имеют фигурные скобки; это кандидат на договорённость.`);
  }
  return {
    candidates,
    unmapped: [],
    warnings,
    observations: {
      declarations: { const: total.const, let: total.let, var: total.var },
      equality: { strict: total.strict, loose: total.loose, nullLoose: total.nullLoose },
      braces: { braced: total.braced, unbraced: total.unbraced },
      functionLines: distribution(functions.map(fn => fn.lines)),
      componentLines: distribution(functions.filter(fn => fn.component).map(fn => fn.lines)),
      parameters: distribution(functions.map(fn => fn.parameters).filter(Number.isFinite)),
      imports: [...imports].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([module, occurrences]) => ({ module, occurrences })),
    },
    coverage: { files: records.length, filesWithMetrics: valid.length, opportunities: { declarations, comparisons, controls }, candidates: candidates.length, executableCandidates: candidates.length, manualCandidates: 0, complete: valid.length === records.length, vocabulary: ['no-var', 'strict-equality', 'require-braces'], architecturalConventionsInferred: false },
  };
}
