import ts from 'typescript';

/** Finite, data-only checks. No project code, tsconfig or plugin is executed. */
export const SUPPORTED_CHECKS = Object.freeze([
  'no-var', 'no-console', 'no-debugger', 'strict-equality',
  'restricted-import', 'restricted-call', 'function-max-lines',
  'component-max-lines', 'max-parameters', 'no-async-promise-executor',
  'require-braces', 'manual',
]);

const supportedChecks = new Set(SUPPORTED_CHECKS);
const functionKinds = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

function scriptKindFor(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.(?:[mc]?js)$/i.test(filePath)) return ts.ScriptKind.JS;
  if (/\.(?:[mc]?ts)$/i.test(filePath)) return ts.ScriptKind.TS;
  throw new TypeError(`Unsupported source extension: ${filePath}`);
}

function walk(root, visitor) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (visitor(node) === false) continue;
    const children = [];
    ts.forEachChild(node, child => { children.push(child); });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

function unwrap(node) {
  while (node && (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )) node = node.expression;
  return node;
}

function staticString(node) {
  node = unwrap(node);
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function memberName(node) {
  node = unwrap(node);
  if (node && ts.isPropertyAccessExpression(node)) return node.name.text;
  if (node && ts.isElementAccessExpression(node)) return staticString(node.argumentExpression);
  return undefined;
}

function callPath(node) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const property = memberName(node);
    const receiver = callPath(node.expression);
    return property !== undefined && receiver !== undefined ? `${receiver}.${property}` : undefined;
  }
  return undefined;
}

function hasAsyncModifier(node) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function isFunctionWithBody(node) {
  return functionKinds.has(node.kind) && Boolean(node.body);
}

function nameText(node, sourceFile) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return node.getText(sourceFile);
}

function inferName(node, sourceFile) {
  if (node.name) return nameText(node.name, sourceFile);
  if (node.kind === ts.SyntaxKind.Constructor) return 'constructor';
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return nameText(parent.name, sourceFile);
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return parent.left.getText(sourceFile);
    }
    if (ts.isExportAssignment(parent)) return 'default';
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent) || ts.isCallExpression(parent)) {
      current = parent;
      continue;
    }
    break;
  }
  if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return 'default';
  return '<anonymous>';
}

function containsJsxExpression(expression) {
  let found = false;
  walk(expression, node => {
    if (found) return false;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      found = true;
      return false;
    }
    if (ts.isCallExpression(node) && ['React.createElement', 'createElement'].includes(callPath(node.expression))) {
      found = true;
      return false;
    }
  });
  return found;
}

function returnsJsx(node) {
  if (!node.body) return false;
  if (!ts.isBlock(node.body)) return containsJsxExpression(node.body);
  let found = false;
  walk(node.body, child => {
    if (found) return false;
    // A JSX return in an unrelated nested function is not this function's return.
    if (isFunctionWithBody(child) || ts.isClassDeclaration(child) || ts.isClassExpression(child)) return false;
    if (ts.isReturnStatement(child) && child.expression && containsJsxExpression(child.expression)) {
      found = true;
      return false;
    }
  });
  return found;
}

function location(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1, endLine: end.line + 1,
    column: start.character + 1, endColumn: end.character + 1,
  };
}

function numericOption(rule, name) {
  const number = rule.check.options?.[name];
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${rule.id}: ${rule.check.kind}.${name} must be a positive integer`);
  }
  return number;
}

function stringArrayOption(rule, name, optional = false) {
  const value = rule.check.options?.[name];
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.length)) {
    throw new TypeError(`${rule.id}: ${rule.check.kind}.${name} must be an array of nonempty strings`);
  }
  return value;
}

function validateRule(rule) {
  if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !rule.id.length) {
    throw new TypeError('Every AST rule needs a nonempty id');
  }
  if (!supportedChecks.has(rule.check?.kind)) throw new TypeError(`${rule.id}: unknown check kind ${rule.check?.kind}`);
  const kind = rule.check.kind;
  if (['function-max-lines', 'component-max-lines', 'max-parameters'].includes(kind)) numericOption(rule, 'max');
  if (kind === 'restricted-call') stringArrayOption(rule, 'callees');
  if (kind === 'restricted-import') stringArrayOption(rule, 'modules');
  if (kind === 'no-console') stringArrayOption(rule, 'allowMethods', true);
  if (kind === 'strict-equality' && rule.check.options?.allowNull !== undefined &&
      typeof rule.check.options.allowNull !== 'boolean') {
    throw new TypeError(`${rule.id}: strict-equality.allowNull must be boolean`);
  }
}

/**
 * Parse JS/TS syntax and run a finite set of declarative checks.
 * Scope, status, approvals and applicability are resolved by the caller.
 * Ranges are 1-based; endColumn is exclusive. Size checks span the complete
 * function/component so changed-line filtering can intersect the whole node.
 */
export function analyzeSource(sourceText, filePath = 'input.ts', rules = []) {
  if (typeof sourceText !== 'string') throw new TypeError('sourceText must be a string');
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath must be a nonempty string');
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  for (const rule of rules) validateRule(rule);

  const scriptKind = scriptKindFor(filePath);
  const extension = { [ts.ScriptKind.TS]: 'ts', [ts.ScriptKind.TSX]: 'tsx', [ts.ScriptKind.JS]: 'js', [ts.ScriptKind.JSX]: 'jsx' }[scriptKind];
  // The compiler host below sees exactly this one source; no dependency/lib lookup.
  const virtualFileName = `/__selfreview__/input.${extension}`;
  const sourceFile = ts.createSourceFile(virtualFileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const parseErrors = sourceFile.parseDiagnostics.map(diagnostic => {
    const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return {
      code: diagnostic.code, line: start.line + 1, column: start.character + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    };
  });
  const metrics = {
    declarations: { const: 0, let: 0, var: 0 },
    equality: { strict: 0, loose: 0, nullLoose: 0 },
    braces: { braced: 0, unbraced: 0 },
    functions: [], components: [], imports: [],
  };
  const coverage = {
    parser: 'typescript', parserVersion: ts.version, parsed: parseErrors.length === 0,
    typeChecked: false, bindingScope: 'single-file',
    componentDetection: 'structural-heuristic',
    restrictedCalls: 'static-syntax-no-alias-or-type-resolution',
  };
  // Do not mine or enforce partially recovered syntax as if it were complete.
  if (parseErrors.length) return { findings: [], parseErrors, metrics, coverage };

  let checker;
  function isUnshadowed(identifier, expectedName) {
    identifier = unwrap(identifier);
    if (!identifier || !ts.isIdentifier(identifier) || identifier.text !== expectedName) return false;
    if (!checker) {
      const normalize = name => name.replaceAll('\\', '/');
      const host = {
        getSourceFile: name => normalize(name) === virtualFileName ? sourceFile : undefined,
        getDefaultLibFileName: () => '/__selfreview__/no-lib.d.ts',
        writeFile: () => {}, getCurrentDirectory: () => '/', getDirectories: () => [],
        fileExists: name => normalize(name) === virtualFileName,
        readFile: name => normalize(name) === virtualFileName ? sourceText : undefined,
        getCanonicalFileName: name => normalize(name),
        useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
      };
      const program = ts.createProgram([virtualFileName], {
        target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true,
        allowJs: true, checkJs: false,
      }, host);
      checker = program.getTypeChecker();
    }
    // A local declaration, import, parameter or ambient declaration owns the name.
    return !checker.getSymbolAtLocation(identifier)?.declarations?.length;
  }

  const records = {
    variables: [], looseEquality: [], console: [], debugger: [], imports: [],
    calls: [], functions: [], components: [], asyncExecutors: [], braces: [],
  };

  function addImport(module, node, kind) {
    if (module === undefined) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    metrics.imports.push({ module, line, kind });
    records.imports.push({ module, node, kind });
  }

  function addBody(body, label) {
    if (!body) return;
    const braced = ts.isBlock(body);
    metrics.braces[braced ? 'braced' : 'unbraced']++;
    records.braces.push({ node: body, label, braced });
  }

  walk(sourceFile, node => {
    if (ts.isVariableDeclarationList(node)) {
      const kind = (node.flags & ts.NodeFlags.Const) ? 'const'
        : (node.flags & ts.NodeFlags.Let) ? 'let'
        : (node.flags & ts.NodeFlags.Using) ? 'using' : 'var';
      if (kind in metrics.declarations) metrics.declarations[kind] += node.declarations.length;
      records.variables.push({ node, kind });
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        metrics.equality.strict++;
      } else if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) {
        const nullComparison = unwrap(node.left).kind === ts.SyntaxKind.NullKeyword || unwrap(node.right).kind === ts.SyntaxKind.NullKeyword;
        metrics.equality.loose++;
        if (nullComparison) metrics.equality.nullLoose++;
        records.looseEquality.push({ node, operator, nullComparison });
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isUnshadowed(node.expression, 'console')) {
      records.console.push({ node, method: memberName(node) });
    }
    if (ts.isDebuggerStatement(node)) records.debugger.push(node);

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addImport(staticString(node.moduleSpecifier), node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 're-export');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addImport(staticString(node.moduleReference.expression), node.moduleReference, 'import-equals');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addImport(staticString(node.argument.literal), node.argument, 'import-type');
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      records.calls.push({ node, path: callPath(node.expression), method: memberName(node.expression) });
      if (ts.isCallExpression(node) && node.arguments.length) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addImport(staticString(node.arguments[0]), node.arguments[0], 'dynamic-import');
        } else if (isUnshadowed(node.expression, 'require')) {
          addImport(staticString(node.arguments[0]), node.arguments[0], 'require');
        }
      }
      if (ts.isNewExpression(node) && isUnshadowed(node.expression, 'Promise')) {
        const executor = unwrap(node.arguments?.[0]);
        if (executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) && hasAsyncModifier(executor)) {
          records.asyncExecutors.push({ node: executor });
        }
      }
    }

    if (isFunctionWithBody(node)) {
      const name = inferName(node, sourceFile);
      const range = location(sourceFile, node);
      const component = (/^[A-Z]/.test(name) || name === 'default') && returnsJsx(node);
      const metric = {
        name, kind: ts.SyntaxKind[node.kind], startLine: range.startLine, endLine: range.endLine,
        lines: range.endLine - range.startLine + 1,
        parameters: node.parameters.filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this')).length,
        component,
      };
      metrics.functions.push(metric);
      records.functions.push({ node, metric });
      if (component) {
        metrics.components.push(metric);
        records.components.push({ node, metric });
      }
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const render = node.members.find(member => nameText(member.name, sourceFile) === 'render');
      const renderFunction = render && ts.isPropertyDeclaration(render) ? unwrap(render.initializer) : render;
      if (renderFunction && isFunctionWithBody(renderFunction) && returnsJsx(renderFunction)) {
        const range = location(sourceFile, node);
        const metric = {
          name: inferName(node, sourceFile), kind: 'ClassComponent',
          startLine: range.startLine, endLine: range.endLine,
          lines: range.endLine - range.startLine + 1, parameters: 0, component: true,
        };
        metrics.components.push(metric);
        records.components.push({ node, metric });
      }
    }

    if (ts.isIfStatement(node)) {
      addBody(node.thenStatement, 'if');
      if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) addBody(node.elseStatement, 'else');
    } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      addBody(node.statement, 'for');
    } else if (ts.isWhileStatement(node)) addBody(node.statement, 'while');
    else if (ts.isDoStatement(node)) addBody(node.statement, 'do');
  });

  const findings = [];
  function report(rule, node, message, extra = {}) {
    findings.push({
      ruleId: rule.id, family: rule.family ?? rule.check.kind,
      title: rule.title ?? rule.check.kind, message,
      severity: rule.severity ?? 'warning', mode: rule.mode ?? 'advisory',
      ...location(sourceFile, node), evidence: rule.evidence ?? [], ...extra,
    });
  }

  for (const rule of rules) {
    const options = rule.check.options ?? {};
    switch (rule.check.kind) {
      case 'no-var':
        for (const item of records.variables) if (item.kind === 'var') report(rule, item.node, 'Use let or const instead of var.');
        break;
      case 'no-console': {
        const allowed = options.allowMethods ?? [];
        for (const item of records.console) if (!allowed.includes(item.method)) {
          report(rule, item.node, `Console member ${item.method ?? '[dynamic]'} is not allowed in this scope.`);
        }
        break;
      }
      case 'no-debugger':
        for (const node of records.debugger) report(rule, node, 'Remove the debugger statement.');
        break;
      case 'strict-equality':
        for (const item of records.looseEquality) if (!options.allowNull || !item.nullComparison) {
          const desired = item.operator === ts.SyntaxKind.EqualsEqualsToken ? '===' : '!==';
          report(rule, item.node, `Use ${desired}; loose equality is not allowed by this rule.`);
        }
        break;
      case 'restricted-import':
        for (const item of records.imports) if (options.modules.some(pattern =>
          pattern === item.module || (pattern.endsWith('/*') && item.module.startsWith(pattern.slice(0, -1))))) {
          report(rule, item.node, `Import of ${item.module} is restricted in this scope.`, { module: item.module, importKind: item.kind });
        }
        break;
      case 'restricted-call':
        for (const item of records.calls) {
          const pattern = options.callees.find(candidate =>
            candidate === item.path || (candidate.startsWith('*.') && item.method === candidate.slice(2)));
          if (pattern !== undefined) report(rule, item.node,
            `Call matches ${pattern}. This is a syntax match; verify receiver type and compatibility before changing it.`,
            { symbol: item.path ?? `*.${item.method}`, matchPrecision: 'syntax' });
        }
        break;
      case 'function-max-lines':
      case 'component-max-lines': {
        const componentRule = rule.check.kind === 'component-max-lines';
        const candidates = componentRule ? records.components : records.functions;
        for (const item of candidates) if (item.metric.lines > options.max) {
          report(rule, item.node,
            `${componentRule ? 'Component' : 'Function'} ${item.metric.name} spans ${item.metric.lines} physical lines (limit ${options.max}). Review responsibilities before decomposing.`,
            { symbol: item.metric.name, metric: { name: 'physical-lines', value: item.metric.lines, limit: options.max },
              matchPrecision: componentRule ? 'structural-heuristic' : 'syntax' });
        }
        break;
      }
      case 'max-parameters':
        for (const item of records.functions) if (item.metric.parameters > options.max) {
          report(rule, item.node, `Function ${item.metric.name} has ${item.metric.parameters} parameters (limit ${options.max}).`,
            { symbol: item.metric.name, metric: { name: 'parameters', value: item.metric.parameters, limit: options.max } });
        }
        break;
      case 'no-async-promise-executor':
        for (const item of records.asyncExecutors) report(rule, item.node,
          'Avoid an async Promise executor: its returned promise is not adopted by the constructed promise.');
        break;
      case 'require-braces':
        for (const item of records.braces) if (!item.braced) report(rule, item.node, `Wrap the ${item.label} body in braces.`);
        break;
      case 'manual':
        break;
      default:
        throw new TypeError(`${rule.id}: unknown check kind ${rule.check.kind}`);
    }
  }
  findings.sort((left, right) => left.startLine - right.startLine || left.column - right.column ||
    (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
  return { findings, parseErrors, metrics, coverage };
}

export const inspectSource = analyzeSource;
