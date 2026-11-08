import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '0.1.0';
export const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
export const DEFAULT_INCLUDE = [...EXTENSIONS].map(e => `**/*${e}`);
export const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.selfreview', 'dist', 'build', 'coverage', '.next', '.nuxt', 'vendor']);
export const posix = value => value.replaceAll('\\', '/');
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const digest = value => sha256(JSON.stringify(stable(value)));
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJson(file, value) { writeAtomic(file, JSON.stringify(value, null, 2) + '\n'); }
export function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function safeRelative(value) {
  assert(typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value), 'Invalid relative path');
  const p = posix(value);
  assert(!p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..'), `Unsafe relative path: ${value}`);
  return p.replace(/^\.\//, '');
}
export function globRegex(pattern) {
  assert(typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 512, 'Invalid glob');
  const p = safeRelative(pattern);
  assert(!/[{}\[\]!]/.test(p), `Unsupported glob syntax: ${pattern}. Use *, ** and ?; list alternatives separately.`);
  let result = '^';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; }
    else if (p[i] === '*') result += '[^/]*';
    else if (p[i] === '?') result += '[^/]';
    else result += p[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}
export function matches(file, include = ['**/*'], exclude = []) {
  const normalized = posix(file);
  return include.some(p => globRegex(p).test(normalized)) && !exclude.some(p => globRegex(p).test(normalized));
}
export function walk(root, { include = DEFAULT_INCLUDE, exclude = [], maxFiles = 10000, maxBytes = 2 * 1024 * 1024, extensions = EXTENSIONS, onlyPaths } = {}) {
  const files = [], skipped = [], errors = [];
  const canonical = fs.realpathSync(root);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = path.join(directory, entry.name), relative = posix(path.relative(canonical, absolute));
      if (entry.isSymbolicLink()) {
        if (EXCLUDED_DIRS.has(entry.name) || matches(relative,exclude,[]) || matches(relative+'/',exclude,[])) continue;
        skipped.push({ path: relative, reason: 'SYMLINK_NOT_FOLLOWED' }); continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || matches(relative + '/', exclude, [])) continue;
        if (onlyPaths && ![...onlyPaths].some(p=>p.startsWith(relative+'/'))) continue;
        visit(absolute); continue;
      }
      if (!entry.isFile() || !matches(relative, include, exclude)) continue;
      if (onlyPaths && !onlyPaths.has(relative)) continue;
      if (extensions && (!extensions.has(path.extname(relative).toLowerCase()) || /\.d\.(?:ts|mts|cts)$/.test(relative))) {
        skipped.push({ path: relative, reason: 'UNSUPPORTED_OR_DECLARATION_FILE' }); continue;
      }
      if (files.length >= maxFiles) { errors.push({ path: relative, reason: 'FILE_LIMIT' }); continue; }
      if (fs.statSync(absolute).size > maxBytes) { errors.push({ path: relative, reason: 'FILE_TOO_LARGE' }); continue; }
      try {
        const bytes = fs.readFileSync(absolute);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        files.push({ path: relative, absolute, source, hash: sha256(bytes) });
      } catch (e) { errors.push({ path: relative, reason: `READ_ERROR: ${e.message}` }); }
    }
  };
  visit(canonical);
  return { files, skipped, errors, root: canonical };
}
export function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,60) || 'project'; }
export function boundedText(value, max = 2000) { return String(value ?? '').slice(0, max); }
