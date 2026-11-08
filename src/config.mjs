import fs from 'node:fs';
import path from 'node:path';
import { assert, readJson, writeJson, matches, globRegex, DEFAULT_INCLUDE, contained, posix, digest } from './util.mjs';
import { validateRule, BEST_PRACTICES } from './rules.mjs';
import { validateLifecycleMetadata } from './lifecycle.mjs';

export function loadConfig(filename = 'selfreview.config.json') {
  const absolute = path.resolve(filename), config = readJson(absolute), baseDir = path.dirname(absolute);
  assert(config.schemaVersion === 1, 'Config schemaVersion must be 1');
  assert(Array.isArray(config.scopes) && config.scopes.length > 0, 'At least one scope required');
  assert(Array.isArray(config.projects) && config.projects.length > 0, 'At least one project required');
  const known = new Set();
  for (const s of config.scopes) {
    assert(typeof s.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,159}$/.test(s.id) && s.id !== 'builtin' && !known.has(s.id), `Duplicate or invalid scope: ${s.id}`); known.add(s.id);
    assert(s.extends === undefined || (Array.isArray(s.extends) && s.extends.every(x => typeof x === 'string')), `Invalid extends: ${s.id}`);
    assert(s.disabledRules === undefined || (Array.isArray(s.disabledRules) && s.disabledRules.every(x => x && typeof x.id === 'string' && typeof x.reason === 'string' && x.reason.trim())), `${s.id}: disabledRules require id and reason`);
  }
  for (const s of config.scopes) scopeChain(config, s.id);
  const ids = new Set(), roots = [];
  for (const p of config.projects) {
    assert(typeof p.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,159}$/.test(p.id) && !ids.has(p.id), `Duplicate or invalid project id: ${p.id}`); ids.add(p.id);
    assert(known.has(p.scope), `${p.id}: unknown scope ${p.scope}`);
    assert(typeof p.root === 'string' && p.root.length, `${p.id}: project root required`);
    const rawRoot = path.resolve(baseDir, p.root);
    assert(fs.existsSync(rawRoot) && fs.statSync(rawRoot).isDirectory(), `Project root is not a directory: ${rawRoot}`);
    const root = fs.realpathSync(rawRoot);
    for (const other of roots) assert(!contained(other.root, root) && !contained(root, other.root), `Ambiguous overlapping project roots: ${other.id} and ${p.id}. Register one project and use rule applicability for subfolders.`);
    roots.push({ id:p.id, root });
    for (const [key,patterns] of [['include',p.include??DEFAULT_INCLUDE],['exclude',p.exclude??[]]]) {
      assert(Array.isArray(patterns) && (key!=='include' || patterns.length>0), `${p.id}: invalid ${key}`);
      patterns.forEach(globRegex);
    }
  }
  if (config.bestPractices !== undefined) assert(typeof config.bestPractices === 'boolean', 'bestPractices must be boolean');
  assert(config.catalog === undefined || typeof config.catalog === 'string', 'catalog must be a path');
  const catalogPath = path.resolve(baseDir, config.catalog ?? '.selfreview/catalog.json');
  return { config, absolute, baseDir, catalogPath, hash:digest(config) };
}
export function scopeChain(config, scope) {
  const result = [], visiting = new Set(), visited = new Set();
  const visit = id => {
    assert(!visiting.has(id), `Scope inheritance cycle: ${id}`);
    if (visited.has(id)) return;
    const value = config.scopes.find(s => s.id === id); assert(value, `Unknown scope: ${id}`);
    visiting.add(id); for (const parent of value.extends ?? []) visit(parent);
    visiting.delete(id); visited.add(id); result.push(id);
  };
  visit(scope); return result;
}
export function loadCatalog(context, { allowStale = false } = {}) {
  assert(fs.existsSync(context.catalogPath), `Rule catalog is missing: ${context.catalogPath}. Use init; a missing catalog is not an empty policy.`);
  const catalog = readJson(context.catalogPath);
  return validateCatalog(context,catalog,{allowStale});
}
export function validateCatalog(context,catalog,{allowStale=false}={}) {
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.rules), 'Invalid rule catalog');
  const ids = new Set();
  for (const rule of catalog.rules) {
    assert(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`); ids.add(rule.id);
    assert(context.config.scopes.some(s => s.id === rule.scope), `${rule.id}: unknown scope ${rule.scope}`);
    if (allowStale && rule.status === 'approved') validateRule({ ...rule, status:'candidate' }); else validateRule(rule);
  }
  const knownIds=new Set([...ids,...BEST_PRACTICES.map(r=>r.id)]);
  for(const scope of context.config.scopes)for(const disabled of scope.disabledRules??[])assert(knownIds.has(disabled.id),`${scope.id}: unknown disabled rule ${disabled.id}`);
  validateLifecycleMetadata(catalog,context);
  return catalog;
}
export function mutateCatalog(context, update, options = {}) {
  fs.mkdirSync(path.dirname(context.catalogPath), {recursive:true});
  const lock = `${context.catalogPath}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Catalog is locked: ${lock}. Another writer may be active.`); throw e; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid:process.pid, time:new Date().toISOString() }));
    const catalog = loadCatalog(context, options), result = update(catalog);
    validateCatalog(context,catalog,options);
    writeJson(context.catalogPath, catalog); return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function projectInfo(context, id) {
  const project = context.config.projects.find(p => p.id === id);
  assert(project, `Unknown project: ${id}`);
  return { ...project, root:fs.realpathSync(path.resolve(context.baseDir, project.root)), include:project.include ?? DEFAULT_INCLUDE, exclude:project.exclude ?? [] };
}
export function resolveRules(config, catalog, scope, relativePath) {
  const chain = scopeChain(config, scope);
  const candidates = catalog.rules.filter(r => chain.includes(r.scope) && r.status === 'candidate' && matches(relativePath,r.applicability?.include,r.applicability?.exclude));
  const active = catalog.rules.filter(r => chain.includes(r.scope) && r.status === 'approved' && matches(relativePath, r.applicability?.include, r.applicability?.exclude));
  const disabled = chain.flatMap(id => config.scopes.find(s => s.id === id).disabledRules ?? []);
  const suppressed = [], conflicts = [];
  const selectable = active.filter(r => {
    const d = disabled.find(x => x.id === r.id); if (d) suppressed.push({id:r.id,reason:d.reason,by:'scope'}); return !d;
  });
  const hidden = new Set();
  const visiting = new Set(), visited = new Set();
  const checkCycle = rule => {
    if (visiting.has(rule.id)) { conflicts.push({family:rule.family,ids:[...visiting,rule.id],reason:'OVERRIDE_CYCLE'}); return; }
    if (visited.has(rule.id)) return;
    visiting.add(rule.id);
    for (const id of rule.overrides ?? []) { const other = selectable.find(r => r.id === id); if (other) checkCycle(other); }
    visiting.delete(rule.id); visited.add(rule.id);
  };
  selectable.forEach(checkCycle);
  for (const rule of selectable) for (const id of rule.overrides ?? []) {
    const original = catalog.rules.find(r => r.id === id);
    if (!original || original.status !== 'approved' || original.family !== rule.family || !scopeChain(config, rule.scope).includes(original.scope)) conflicts.push({family:rule.family,ids:[rule.id,id],reason:'INVALID_OVERRIDE_TARGET'});
    else if (selectable.some(r => r.id === id)) { hidden.add(id); suppressed.push({id,by:rule.id,reason:rule.overrideReason}); }
  }
  const rules = selectable.filter(r => !hidden.has(r.id));
  const groups = new Map();
  for (const r of rules) { const group = groups.get(r.family) ?? []; group.push(r); groups.set(r.family,group); }
  for (const [family, group] of groups) if (group.length > 1) conflicts.push({family,ids:group.map(r => r.id).sort(),reason:'OVERLAPPING_RULE_VARIANTS_REQUIRE_EXPLICIT_OVERRIDE'});
  const conventionFamilies = new Set(rules.map(r => r.family));
  if (config.bestPractices !== false) for (const r of BEST_PRACTICES) {
    const d = disabled.find(x => x.id === r.id);
    // The restricted-call family can be subdivided by callee; conservatively defer the entire advice family.
    const overridden = rules.some(x => x.family === r.family || x.check.kind === r.check.kind);
    if (d || overridden) suppressed.push({id:r.id,by:d?'scope':'convention',reason:d?.reason ?? 'Project convention takes precedence'});
    else rules.push(r);
  }
  return { rules, candidates, conflicts, suppressed, scopeChain:chain, conventionFamilies:[...conventionFamilies] };
}
export function allScopeRules(config,catalog,scope) {
  const chain = scopeChain(config,scope);
  return catalog.rules.filter(r => chain.includes(r.scope));
}
