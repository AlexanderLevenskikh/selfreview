import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseUnifiedDiff } from './diff.mjs';
import { assert, contained, safeRelative, sha256, EXTENSIONS } from './util.mjs';

const SNAPSHOT = Symbol('SelfReview Git snapshot');
const snapshots = new WeakMap();
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const OID = /^[a-f0-9]{40,64}$/;

export function projectRelativeFile(value) {
  const relative = safeRelative(value);
  assert(!/[\x00-\x1f\x7f:]/.test(relative) && !relative.split('/').some(part => !part || part === '.'), `Invalid project-relative file: ${value}`);
  return relative;
}

export function isSourcePath(name) {
  return EXTENSIONS.has(path.extname(name).toLowerCase()) && !/\.d\.(?:ts|mts|cts)$/i.test(name);
}

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function readWorktree(root, name) {
  try {
    name = projectRelativeFile(name);
    let current = root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return { path: name, error: 'SOURCE_SYMLINK_NOT_ANALYZED' };
    }
    const stat = fs.statSync(current);
    if (!stat.isFile()) return { path: name, error: 'SOURCE_NOT_REGULAR_FILE' };
    if (stat.size > MAX_SOURCE_BYTES) return { path: name, error: 'FILE_TOO_LARGE' };
    const bytes = fs.readFileSync(current);
    if (bytes.length > MAX_SOURCE_BYTES) return { path: name, error: 'FILE_TOO_LARGE' };
    return { path: name, absolute: current, source: decode(bytes), hash: sha256(bytes), bytes };
  } catch (error) {
    return { path: name, error: `READ_ERROR: ${error.message}` };
  }
}

function gitClient(root) {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
  for (const key of Object.keys(env)) if ([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  ].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete env[key];
  // The flag fails closed on older Git instead of silently ignoring the env var.
  // Missing promisor objects must never invoke a fetch or its configured helpers.
  const prefix = ['--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice}`];
  const options = { cwd: root, env, maxBuffer: 32 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] };
  const run = (args, binary = false) => execFileSync('git', [...prefix, ...args], { ...options, ...(binary ? {} : { encoding: 'utf8' }) });
  // Git resolves its own Windows aliases. A nested checkout path is not a root.
  assert(run(['rev-parse', '--is-inside-work-tree', '--show-prefix']).replace(/\r\n/g, '\n') === 'true\n\n',
    'The configured project must be the Git root; refusing to inspect a parent repository');
  // Diff may otherwise run clean/process filters even with --no-textconv.
  let keys = '';
  try { keys = run(['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']); }
  catch (error) { if (error.status !== 1) throw error; }
  for (const key of keys.split(/\r?\n/).filter(Boolean)) prefix.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  return run;
}

function indexEntries(raw) {
  const entries = new Map(), errors = [];
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    assert(match, 'Malformed Git index entry');
    const [, mode, oid, stage, name] = match;
    if (stage !== '0') { errors.push({ path: name, reason: 'UNMERGED_INDEX_ENTRY' }); continue; }
    entries.set(name, { mode, oid, path: name });
  }
  return { entries, errors };
}

function treeEntries(raw) {
  const entries = new Map();
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
    assert(match, 'Malformed Git tree entry');
    const [, mode, type, oid, name] = match;
    entries.set(name, { mode, type, oid, path: name });
  }
  return entries;
}

/** Read-only Git comparison. Source bytes come from immutable blobs for --staged. */
export function diffFromGit(projectRoot, base, { mergeBase = false, staged = false } = {}) {
  assert(typeof base === 'string' && /^[A-Za-z0-9_./~^@{}-]+$/.test(base) && !base.startsWith('-'), 'Invalid Git base ref');
  assert(typeof mergeBase === 'boolean' && typeof staged === 'boolean', 'Git comparison flags must be boolean');
  const root = fs.realpathSync(projectRoot), run = gitClient(root);
  const resolvedBase = run(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const headCommit = run(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  assert(OID.test(resolvedBase) && OID.test(headCommit), 'Git did not resolve immutable commit IDs');
  let baseCommit = resolvedBase;
  if (mergeBase) {
    const bases = run(['merge-base', '--all', resolvedBase, headCommit]).trim().split(/\r?\n/);
    assert(bases.length === 1 && OID.test(bases[0]), 'A unique merge base is required; ambiguous histories are not inferred');
    [baseCommit] = bases;
  }
  const indexRaw = run(['ls-files', '--stage', '-z']);
  const index = indexEntries(indexRaw);
  const baseEntries = treeEntries(run(['ls-tree', '-r', '-z', '--full-tree', baseCommit]));
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--find-renames=50%', '--unified=0', ...(staged ? ['--cached'] : []), baseCommit, '--'];
  const diffText = run(diffArgs);
  const untracked = staged ? [] : run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const errors = [...index.errors];
  if (run(['ls-files', '--stage', '-z']) !== indexRaw) errors.push({ reason: 'INDEX_CHANGED_DURING_SNAPSHOT' });
  const blobCache = new Map();
  const readBlob = (entries, name) => {
    try {
      name = projectRelativeFile(name);
      const entry = entries.get(name);
      if (!entry) return { path: name, missing: true };
      if (!['100644', '100755'].includes(entry.mode)) return { path: name, error: entry.mode === '120000' ? 'SOURCE_SYMLINK_NOT_ANALYZED' : 'SOURCE_NOT_REGULAR_FILE' };
      if (!blobCache.has(entry.oid)) {
        const size = Number(run(['cat-file', '-s', entry.oid]).trim());
        assert(Number.isSafeInteger(size) && size >= 0, 'Invalid Git blob size');
        if (size > MAX_SOURCE_BYTES) return { path: name, error: 'FILE_TOO_LARGE' };
        const bytes = run(['cat-file', 'blob', entry.oid], true);
        assert(bytes.length === size, 'Git blob size changed while reading');
        blobCache.set(entry.oid, { source: decode(bytes), hash: sha256(bytes), bytes });
      }
      return { ...blobCache.get(entry.oid), path: name, gitBlobOid: entry.oid };
    } catch (error) { return { path: name, error: `GIT_BLOB_READ_ERROR: ${error.message}` }; }
  };
  const parsed = parseUnifiedDiff(diffText), targetSnapshots = new Map();
  if (!parsed.errors.length) {
    for (const name of new Set([...parsed.files.map(file => file.newPath).filter(Boolean), ...untracked])) {
      if (!isSourcePath(name)) continue;
      targetSnapshots.set(name, staged ? readBlob(index.entries, name) : readWorktree(root, name));
    }
  }
  const metadata = Object.freeze({
    requestedBase: base, resolvedBase, headCommit, baseCommit,
    baseMode: mergeBase ? 'merge-base' : 'ref', target: staged ? 'index' : 'working-tree',
    diffSha256: sha256(diffText), indexSha256: sha256(indexRaw), capturedAt: new Date().toISOString(),
    postimages: [...targetSnapshots.values()].filter(file => file.hash).map(file => ({ path: file.path, sha256: file.hash, ...(file.gitBlobOid ? { gitBlobOid: file.gitBlobOid } : {}) })),
  });
  const token = Object.freeze({});
  snapshots.set(token, {
    root, metadata, diffText, untracked, errors, staged, baseEntries, indexEntries: index.entries, targetSnapshots,
    readBase: name => readBlob(baseEntries, name),
    readIndex: name => readBlob(index.entries, name),
    readWorktree: name => readWorktree(root, name),
    verifyIndex: () => run(['ls-files', '--stage', '-z']) === indexRaw,
    verifyWorktree: () => run(diffArgs) === diffText && JSON.stringify(run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) === JSON.stringify(untracked),
  });
  // The symbol survives an object spread but cannot be forged by an imported JSON diff.
  return { diffText, untracked, diffOrigin: 'local-git', git: metadata, [SNAPSHOT]: token };
}

export function gitComparison(options, projectRoot) {
  const snapshot = snapshots.get(options[SNAPSHOT]);
  if (!snapshot) return null;
  const root = fs.realpathSync(projectRoot);
  assert(contained(snapshot.root, root) && contained(root, snapshot.root), 'Git snapshot belongs to a different project root');
  assert(options.diffText === snapshot.diffText && JSON.stringify(options.untracked ?? []) === JSON.stringify(snapshot.untracked), 'Git snapshot diff or file inventory was changed');
  return snapshot;
}
