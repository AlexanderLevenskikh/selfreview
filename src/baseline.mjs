import ts from 'typescript';
import { digest } from './util.mjs';
import { scopeChain } from './config.mjs';

/** Evidence and lifecycle metadata do not change executable policy. */
export function effectivePolicy(config, catalog, projectId) {
  const project = config.projects.find(item => item.id === projectId);
  if (!project) return null;
  const chain = scopeChain(config, project.scope);
  return {
    project: { id: project.id, root: project.root, scope: project.scope, include: project.include ?? null, exclude: project.exclude ?? [] },
    bestPractices: config.bestPractices !== false,
    scopes: chain.map(id => {
      const scope = config.scopes.find(item => item.id === id);
      return { id, extends: scope.extends ?? [], disabledRules: (scope.disabledRules ?? []).map(rule => rule.id).sort() };
    }),
    rules: catalog.rules.filter(rule => rule.status === 'approved' && chain.includes(rule.scope)).map(rule => ({
      id: rule.id, scope: rule.scope, family: rule.family, mode: rule.mode, severity: rule.severity,
      check: { kind: rule.check.kind, options: rule.check.options ?? {} },
      applicability: rule.applicability ?? { include: ['**/*'], exclude: [] },
      overrides: [...(rule.overrides ?? [])].sort(),
      ...(rule.check.kind === 'manual' ? { title: rule.title, description: rule.description } : {}),
    })).sort((left, right) => left.id.localeCompare(right.id, 'en')),
  };
}

function fragment(source, finding) {
  const lines = source.split(/\r?\n/);
  if (finding.startLine === finding.endLine) return (lines[finding.startLine - 1] ?? '').slice(finding.column - 1, finding.endColumn - 1);
  const selected = lines.slice(finding.startLine - 1, finding.endLine);
  if (!selected.length) return '';
  selected[0] = selected[0].slice(finding.column - 1);
  selected[selected.length - 1] = selected.at(-1).slice(0, finding.endColumn - 1);
  return selected.join('\n');
}

function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    result.push([token, token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NumericLiteral ? scanner.getTokenValue() : scanner.getTokenText()]);
  }
  return result;
}

function metricSubjects(source, filePath) {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const result = new Map();
  const named = node => node.name ? node.name.getText(file) : null;
  const visit = node => {
    if ((ts.isFunctionLike(node) && node.body) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const owners = [];
      for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isFunctionLike(parent) || ts.isModuleDeclaration(parent)) {
          owners.push([parent.kind, named(parent) ?? '<anonymous-owner>']);
        } else if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
          owners.push([parent.kind, named(parent)]);
        } else if (ts.isIfStatement(parent)) {
          owners.push([parent.kind, child === parent.thenStatement ? 'then' : 'else', tokens(parent.expression.getText(file))]);
        } else if (ts.isBlock(parent) && (ts.isBlock(parent.parent) || ts.isSourceFile(parent.parent))) {
          const siblings = [...parent.parent.statements].filter(ts.isBlock);
          owners.push([parent.kind, siblings.indexOf(parent)]);
        }
      }
      const start = file.getLineAndCharacterOfPosition(node.getStart(file));
      result.set(`${start.line + 1}:${start.character + 1}`, { kind: node.kind, owners: owners.reverse() });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function findingKey(finding, source, kinds, subjects) {
  const kind = kinds.get(finding.ruleId);
  const subject = subjects.get(`${finding.startLine}:${finding.column}`);
  const namedSizeCheck = ['function-max-lines', 'component-max-lines', 'max-parameters'].includes(kind)
    && finding.symbol && finding.symbol !== '<anonymous>' && subject;
  // Size violations stay attached to the named function when its body changes.
  // Other checks conservatively require the same token sequence (without trivia).
  const identity = namedSizeCheck ? { symbol: finding.symbol, ...subject } : { tokens: tokens(fragment(source, finding)) };
  return digest({ ruleId: finding.ruleId, kind, identity });
}

function mappedLine(line, hunks) {
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0 ? line <= hunk.oldStart : line < hunk.oldStart) return line + offset;
    if (hunk.oldCount > 0 && line < hunk.oldStart + hunk.oldCount) return null;
    offset += hunk.newCount - hunk.oldCount;
  }
  return line + offset;
}

const location = finding => ({ path: finding.path, startLine: finding.startLine, endLine: finding.endLine, column: finding.column, endColumn: finding.endColumn });

/**
 * Count-preserving, per-file occurrence matching. It is not semantic equivalence.
 * Unchanged positions are paired first, so an inserted identical occurrence is
 * reported at the inserted line rather than at the shifted pre-existing line.
 */
export function compareFindings(before, after, { oldSource = '', newSource = '', rules = [], hunks = [] } = {}) {
  const kinds = new Map(rules.map(rule => [rule.id, rule.check.kind]));
  const oldGroups = new Map(), newGroups = new Map();
  for (const [items, source, groups] of [[before, oldSource, oldGroups], [after, newSource, newGroups]]) {
    const subjects = items.some(finding => finding.metric) ? metricSubjects(source, items[0]?.path ?? 'input.ts') : new Map();
    for (const finding of items) {
      const key = findingKey(finding, source, kinds, subjects), group = groups.get(key) ?? [];
      group.push(finding); groups.set(key, group);
    }
  }
  const newFindings = [], existingFindings = [], resolvedFindings = [];
  for (const key of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    const old = [...(oldGroups.get(key) ?? [])], current = [...(newGroups.get(key) ?? [])];
    const pairedOld = new Set(), pairedNew = new Set();
    const pair = (oldIndex, newIndex) => {
      pairedOld.add(oldIndex); pairedNew.add(newIndex);
      const prior = old[oldIndex], finding = current[newIndex];
      const worsened = finding.metric && prior.metric && finding.metric.name === prior.metric.name && finding.metric.value > prior.metric.value;
      const matched = { ...finding, baselineState: worsened ? 'new' : 'existing', baselineFingerprint: key, baselineLocation: location(prior), ...(finding.metric ? { previousMetric: prior.metric } : {}) };
      if (worsened) newFindings.push({ ...matched, baselineChange: 'worsened' });
      else existingFindings.push(matched);
    };
    for (let index = 0; index < old.length; index++) {
      const line = mappedLine(old[index].startLine, hunks);
      if (line === null) continue;
      const match = current.findIndex((finding, candidate) => !pairedNew.has(candidate) && finding.startLine === line && finding.column === old[index].column);
      if (match !== -1) pair(index, match);
    }
    for (let index = 0; index < old.length; index++) {
      if (pairedOld.has(index)) continue;
      // Repeated unnamed lexical owners are ambiguous after edits: keep new
      // metric occurrences visible rather than guessing which owner survived.
      if (old[index].metric && (old.length > 1 || current.length > 1)) continue;
      const match = current.findIndex((finding, candidate) => !pairedNew.has(candidate));
      if (match !== -1) pair(index, match);
    }
    for (let index = 0; index < current.length; index++) if (!pairedNew.has(index)) newFindings.push({ ...current[index], baselineState: 'new', baselineFingerprint: key });
    for (let index = 0; index < old.length; index++) if (!pairedOld.has(index)) resolvedFindings.push({ ...old[index], baselineState: 'resolved', baselineFingerprint: key });
  }
  return { newFindings, existingFindings, resolvedFindings };
}
