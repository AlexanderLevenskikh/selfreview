import fs from 'node:fs';
import path from 'node:path';
import { analyzeSource } from './ast.mjs';
import { loadConfig, loadCatalog, projectInfo, resolveRules, allScopeRules, scopeChain } from './config.mjs';
import { BEST_PRACTICES, validateRule } from './rules.mjs';
import { VERSION, EXTENSIONS, EXCLUDED_DIRS, contained, matches, posix, assert } from './util.mjs';

const NAMESPACE = 'selfreview';
const ruleKey = id => `check.${id}`;

function definitions(context, catalog, project) {
  const scopes = scopeChain(context.config, project.scope);
  const disabled = new Set(scopes.flatMap(id => context.config.scopes.find(scope => scope.id === id).disabledRules ?? []).map(item => item.id));
  const conventions = allScopeRules(context.config, catalog, project.scope);
  const checked = conventions.filter(rule => rule.status === 'approved' && rule.check.kind !== 'manual' && !disabled.has(rule.id));
  if (context.config.bestPractices !== false) checked.push(...BEST_PRACTICES.filter(rule => !disabled.has(rule.id)));
  const ids = new Set();
  for (const rule of checked) {
    assert(!ids.has(rule.id), `ESLint cannot export duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    validateRule(rule);
  }
  return { checked, conventions, disabled };
}

/** Describe configured coverage, not a claim that every project file was linted. */
export function describeEslintCoverage(context, catalog, projectId) {
  const project = projectInfo(context, projectId);
  const { checked, conventions, disabled } = definitions(context, catalog, project);
  return {
    project: project.id, scope: project.scope, engine: 'same-typescript-ast',
    integrityRule: `${NAMESPACE}/integrity`,
    exportedRuleIds: checked.map(rule => rule.id).sort(),
    manualRuleIds: conventions.filter(rule => rule.status === 'approved' && rule.check.kind === 'manual' && !disabled.has(rule.id)).map(rule => rule.id).sort(),
    candidateRuleIds: conventions.filter(rule => rule.status === 'candidate').map(rule => rule.id).sort(),
    limitations: [
      'Only approved AST checks and advisory heuristics are exported. Manual conventions and candidates are not enforced.',
      'TypeScript and TSX require a TypeScript-aware ESLint parser supplied by the host configuration.',
      'ESLint reports only the files it receives; use the SelfReview CLI for inventory, diff coverage and the manual checklist.',
      'Advice becomes an ESLint warning. A host --max-warnings=0 policy can therefore fail on advice.',
    ],
  };
}

function fileIdentity(filename, project) {
  if (typeof filename !== 'string' || !filename || /^<.*>$/.test(filename)) {
    return { issue: 'UNRESOLVED_FILE_PATH: supply a project filename, including --stdin-filename for stdin.' };
  }
  const absolute = path.resolve(filename);
  if (!contained(project.root, absolute)) return { issue: 'OUTSIDE_PROJECT_ROOT: filename does not belong to the selected SelfReview project.' };
  // LintText/IDE buffers may refer to an unsaved file. Check every existing
  // ancestor through realpath without reading any source from disk.
  let existing = absolute;
  while (!fs.existsSync(existing) && existing !== project.root) existing = path.dirname(existing);
  const canonical = fs.realpathSync(existing);
  if (!contained(project.root, canonical)) return { issue: 'FILE_ESCAPES_PROJECT_ROOT: a symlink resolves outside the selected project.' };
  if (path.relative(existing, canonical) !== '') return { issue: 'SYMLINK_NOT_SUPPORTED: SelfReview does not analyze source through symlink paths.' };
  const relative = posix(path.relative(project.root, absolute));
  const skipped = relative.split('/').some(part => EXCLUDED_DIRS.has(part)) ||
    /\.d\.(?:ts|mts|cts)$/i.test(relative) || !matches(relative, project.include, project.exclude);
  if (skipped) return { relative, skipped: true };
  if (!EXTENSIONS.has(path.extname(relative).toLowerCase())) return { issue: `UNSUPPORTED_SOURCE_EXTENSION: ${relative}` };
  return { relative };
}

function eslintLocation(sourceCode, finding) {
  const lines = sourceCode.lines.length ? sourceCode.lines : [''];
  const startLine = Math.max(1, Math.min(lines.length, finding.startLine ?? finding.line ?? 1));
  const endLine = Math.max(startLine, Math.min(lines.length, finding.endLine ?? startLine));
  const startColumn = Math.max(0, Math.min(lines[startLine - 1].length, (finding.column ?? 1) - 1));
  let endColumn = Math.max(0, Math.min(lines[endLine - 1].length, (finding.endColumn ?? finding.column ?? 1) - 1));
  if (endLine === startLine) endColumn = Math.max(startColumn, endColumn);
  return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
}

/**
 * Create a normal ESLint plugin for one selected project. Use its recommended
 * config (or createFlatConfig) to retain the mandatory integrity rule.
 * The catalog/config snapshot is loaded once for this plugin instance.
 */
export function createPlugin(inputContext, inputCatalog, projectId) {
  const context = { ...inputContext, config: structuredClone(inputContext.config) };
  const catalog = structuredClone(inputCatalog);
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.rules), 'Invalid rule catalog');
  const catalogIds = new Set();
  for (const rule of catalog.rules) {
    assert(!catalogIds.has(rule.id), `Duplicate rule id: ${rule.id}`);
    catalogIds.add(rule.id);
    validateRule(rule);
  }
  const project = projectInfo(context, projectId);
  const { checked } = definitions(context, catalog, project);
  const cache = new WeakMap();

  function stateFor(eslintContext) {
    const sourceCode = eslintContext.sourceCode;
    const filename = eslintContext.physicalFilename ?? eslintContext.filename;
    let fileCache = cache.get(sourceCode);
    if (!fileCache) { fileCache = new Map(); cache.set(sourceCode, fileCache); }
    if (fileCache.has(filename)) return fileCache.get(filename);
    let state;
    try {
      const identity = fileIdentity(filename, project);
      if (identity.issue) state = { issues: [{ message: identity.issue }], findings: [] };
      else if (identity.skipped) state = { issues: [], findings: [] };
      else if (Buffer.byteLength(sourceCode.text, 'utf8') > 2 * 1024 * 1024) {
        state = { issues: [{ message: 'SOURCE_TOO_LARGE: input exceeds the 2 MiB source limit.' }], findings: [] };
      } else {
        const resolved = resolveRules(context.config, catalog, project.scope, identity.relative);
        if (resolved.conflicts.length) state = {
          issues: resolved.conflicts.map(conflict => ({ message: `RULE_CONFLICT: ${conflict.family}: ${conflict.reason} (${conflict.ids.join(', ')})` })),
          findings: [],
        };
        else {
          for (const rule of resolved.rules) validateRule(rule);
          const analysis = analyzeSource(sourceCode.text, identity.relative, resolved.rules);
          state = {
            issues: analysis.parseErrors.map(error => ({ ...error, message: `AST_PARSE_ERROR: ${error.message}` })),
            findings: analysis.findings,
          };
        }
      }
    } catch (error) {
      state = { issues: [{ message: `SELFREVIEW_INCOMPLETE: ${error.message}` }], findings: [] };
    }
    fileCache.set(filename, state);
    return state;
  }

  const plugin = {
    meta: { name: '@selfreview/core', version: VERSION, namespace: NAMESPACE },
    rules: {
      integrity: {
        meta: { type: 'problem', docs: { description: 'Fail when SelfReview cannot safely resolve the selected rules or source.' }, schema: [] },
        create(eslintContext) {
          return { Program() {
            for (const issue of stateFor(eslintContext).issues) {
              eslintContext.report({ loc: eslintLocation(eslintContext.sourceCode, issue), message: issue.message });
            }
          } };
        },
      },
    },
    configs: {},
  };
  const settings = { [`${NAMESPACE}/integrity`]: 'error' };
  for (const rule of checked) {
    const name = ruleKey(rule.id);
    plugin.rules[name] = {
      meta: {
        type: rule.mode === 'enforce' && rule.severity === 'error' ? 'problem' : 'suggestion',
        docs: { description: rule.title }, schema: [],
      },
      create(eslintContext) {
        return { Program() {
          for (const finding of stateFor(eslintContext).findings) if (finding.ruleId === rule.id) {
            eslintContext.report({ loc: eslintLocation(eslintContext.sourceCode, finding), message: finding.message });
          }
        } };
      },
    };
    settings[`${NAMESPACE}/${name}`] = rule.mode === 'enforce' && rule.severity === 'error' ? 'error' : 'warn';
  }
  plugin.configs.recommended = {
    name: `selfreview/${project.id}`,
    basePath: project.root,
    files: project.include,
    ignores: [...EXCLUDED_DIRS].map(directory => `**/${directory}/**`).concat(['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'], project.exclude),
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { [NAMESPACE]: plugin },
    rules: settings,
  };
  return plugin;
}

/** Flat config for one explicitly selected project. No automatic scope guessing. */
export function createFlatConfig(configPath, projectId) {
  const context = loadConfig(configPath);
  const catalog = loadCatalog(context);
  return [createPlugin(context, catalog, projectId).configs.recommended];
}
