import { assert, digest, isObject, globRegex } from './util.mjs';

export const KINDS = Object.freeze({
  'no-var': {}, 'no-console': { allowMethods: 'strings' }, 'no-debugger': {},
  'strict-equality': { allowNull: 'boolean' }, 'restricted-import': { modules: 'strings!' },
  'restricted-call': { callees: 'strings!' }, 'function-max-lines': { max: 'positive!' },
  'component-max-lines': { max: 'positive!' }, 'max-parameters': { max: 'positive!' },
  'no-async-promise-executor': {}, 'require-braces': {}, manual: {},
});
const RULE_KEYS = new Set(['id','family','title','description','scope','status','severity','mode','check','applicability','evidence','rationale','confidence','observations','approval','overrides','overrideReason','rejection','examples','createdAt']);
const ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
export function behaviorHash(rule) {
  const { approval, status, rejection, createdAt, ...behavior } = rule;
  return digest(behavior);
}
export function validateRule(rule) {
  assert(isObject(rule), 'Rule must be an object');
  for (const k of Object.keys(rule)) assert(RULE_KEYS.has(k), `Unknown rule field: ${k}`);
  assert(typeof rule.id === 'string' && ID.test(rule.id), 'Rule id must contain only lowercase letters, numbers, dot, underscore, hyphen');
  assert(typeof rule.family === 'string' && rule.family.length > 0 && rule.family.length <= 160 && !/[\r\n\0]/.test(rule.family), `${rule.id}: invalid family`);
  assert(typeof rule.scope === 'string' && ID.test(rule.scope), `${rule.id}: invalid scope`);
  assert(rule.scope === 'builtin' || !rule.id.startsWith('bp.'), `${rule.id}: bp. is reserved for built-in advice`);
  assert(typeof rule.title === 'string' && rule.title.trim().length > 0 && rule.title.length <= 1000, `${rule.id}: title is required`);
  assert(typeof rule.description === 'string' && rule.description.length <= 20000, `${rule.id}: description is required`);
  assert(['candidate','approved','rejected'].includes(rule.status), `${rule.id}: invalid status`);
  assert(['error','warning','info'].includes(rule.severity), `${rule.id}: invalid severity`);
  assert(['enforce','advisory'].includes(rule.mode), `${rule.id}: invalid mode`);
  assert(isObject(rule.check) && Object.keys(rule.check).every(k => ['kind','options'].includes(k)), `${rule.id}: invalid check`);
  assert(Object.hasOwn(KINDS, rule.check.kind), `${rule.id}: unsupported check kind ${rule.check.kind}`);
  const specs = KINDS[rule.check.kind], options = rule.check.options ?? {};
  assert(isObject(options), `${rule.id}: options must be an object`);
  for (const key of Object.keys(options)) assert(Object.hasOwn(specs, key), `${rule.id}: unknown option ${key}`);
  for (const [key, type] of Object.entries(specs)) {
    const value = options[key];
    if (value === undefined) { assert(!type.endsWith('!'), `${rule.id}: missing option ${key}`); continue; }
    if (type.startsWith('strings')) assert(Array.isArray(value) && value.length <= 100 && (!type.endsWith('!') || value.length > 0) && value.every(s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\0\n\r]/.test(s)), `${rule.id}: ${key} must be a bounded string array`);
    if (type === 'boolean') assert(typeof value === 'boolean', `${rule.id}: ${key} must be boolean`);
    if (type.startsWith('positive')) assert(Number.isInteger(value) && value >= 1 && value <= 100000, `${rule.id}: ${key} must be a positive integer`);
  }
  if (rule.applicability !== undefined) {
    assert(isObject(rule.applicability) && Object.keys(rule.applicability).every(k => ['include','exclude'].includes(k)), `${rule.id}: invalid applicability`);
    for (const key of ['include','exclude']) if (rule.applicability[key] !== undefined) {
      assert(Array.isArray(rule.applicability[key]) && rule.applicability[key].length <= 100, `${rule.id}: invalid ${key}`);
      rule.applicability[key].forEach(globRegex);
    }
    assert(!rule.applicability.include || rule.applicability.include.length > 0, `${rule.id}: empty include`);
  }
  assert(Array.isArray(rule.evidence) && rule.evidence.length > 0 && rule.evidence.length <= 500, `${rule.id}: evidence is required`);
  for (const evidence of rule.evidence) {
    assert(isObject(evidence) && typeof evidence.kind === 'string' && typeof evidence.path === 'string', `${rule.id}: invalid evidence`);
    assert(typeof evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256), `${rule.id}: evidence SHA-256 is required`);
    if (evidence.excerpt !== undefined) assert(typeof evidence.excerpt === 'string' && evidence.excerpt.length <= 20000, `${rule.id}: excerpt too large`);
  }
  if (rule.overrides !== undefined) {
    assert(Array.isArray(rule.overrides) && rule.overrides.every(x => typeof x === 'string' && ID.test(x)) && !rule.overrides.includes(rule.id), `${rule.id}: invalid overrides`);
    assert(rule.overrides.length === 0 || (typeof rule.overrideReason === 'string' && rule.overrideReason.trim()), `${rule.id}: overrideReason required`);
  }
  if (rule.status === 'approved') {
    assert(isObject(rule.approval) && typeof rule.approval.by === 'string' && rule.approval.by.trim() && typeof rule.approval.reason === 'string' && rule.approval.reason.trim(), `${rule.id}: approval with by/reason required`);
    assert(rule.approval.behaviorHash === behaviorHash(rule), `${rule.id}: STALE_APPROVAL — behavior or evidence changed; approve the reviewed version again`);
  }
  return rule;
}
export function approveRule(rule, by, reason, date = new Date().toISOString()) {
  assert(by && by.trim() && reason && reason.trim(), 'Approval requires --by and --reason');
  const next = { ...rule, status: 'candidate' }; delete next.approval; delete next.rejection;
  validateRule(next);
  next.status = 'approved'; next.approval = { by, reason, at: date, behaviorHash: behaviorHash(next) };
  return validateRule(next);
}
function builtin(id, title, description, kind, options = {}) {
  const evidence = { kind: 'builtin', path: 'selfreview:best-practices/v1', sha256: digest({ id, title, description, kind, options }), excerpt: 'Advisory heuristic, not a project convention.' };
  return approveRule({ id: `bp.${id}`, family: kind, scope: 'builtin', title, description, status:'candidate', mode:'advisory', severity:'info', check:{kind,options}, evidence:[evidence] }, 'SelfReview built-in', 'Optional advisory heuristic; project conventions take precedence', '2026-11-08T00:00:00.000Z');
}
export const BEST_PRACTICES = [
  builtin('no-var','Проверьте использование var','Рассмотрите let/const, если это допускают runtime и соглашения команды.','no-var'),
  builtin('strict-equality','Проверьте нестрогое сравнение','Проверьте, нужна ли здесь coercion. Сравнение с null разрешено этим советом.','strict-equality',{allowNull:true}),
  builtin('component-size','Проверьте обязанности компонента','150 физических строк — сигнал для ручного анализа, а не доказательство плохой декомпозиции.','component-max-lines',{max:150}),
  builtin('function-size','Проверьте обязанности функции','80 физических строк — эвристика. Разделяйте по ответственности, не ради счётчика строк.','function-max-lines',{max:80}),
  builtin('parameters','Проверьте интерфейс функции','Более пяти параметров может означать несколько независимых обязанностей.','max-parameters',{max:5}),
  builtin('async-executor','Проверьте async executor Promise','Проверьте обработку исключений и необходимость дополнительного Promise.','no-async-promise-executor'),
  builtin('legacy-calls','Проверьте потенциально устаревший вызов','Совпадение синтаксическое: тип получателя и совместимость автоматически не доказаны. Не заменяйте API без проверки поведения.','restricted-call',{callees:['*.substr','document.write']}),
];
