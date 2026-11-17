import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedMarkdown() {
  // Track only repository documents, never node_modules or generated copies.
  // Git pathspec *.md matches Markdown files in nested directories too.
  const git = spawnSync('git', ['ls-files', '--cached', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(git.status, 0, git.stderr || 'Unable to list tracked Markdown');
  return git.stdout.split('\0').filter(Boolean).map(p => p.replaceAll('\\', '/'));
}

test('every tracked Markdown primary document has a tracked .ru.md counterpart', () => {
  const paths = trackedMarkdown();
  assert.ok(paths.includes('README.md'), 'README is part of the tracked docs');
  const set = new Set(paths);
  const primary = paths.filter(p => !p.endsWith('.ru.md'));
  const missing = primary.filter(p => !set.has(p.slice(0, -3) + '.ru.md'));
  assert.deepEqual(missing, [], \`Missing paired Russian documents: \${missing.join(', ')}\`);
  for (const p of primary) {
    const ru = p.slice(0, -3) + '.ru.md';
    assert.ok(fs.statSync(path.join(root, ru)).size > 0, \`Empty Russian pair: \${ru}\`);
  }
});

test('tracked Markdown local links resolve to checked-in files', () => {
  const paths = trackedMarkdown();
  const tracked = new Set(paths);
  const failures = [];
  for (const p of paths) {
    const source = fs.readFileSync(path.join(root, p), 'utf8');
    // Markdown link targets written as ordinary relative paths. This does not
    // validate external URLs, anchors, images or links in fenced code examples.
    const markdownLink = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
    for (const match of source.matchAll(markdownLink)) {
      let target = match[1].trim();
      if (/^(?:[a-z][\w+.-]*:|#|\/)/i.test(target)) continue;
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      target = target.split('#', 1)[0].split('?', 1)[0];
      if (!target) continue;
      try { target = decodeURIComponent(target); }
      catch { failures.push(\`\${p}: invalid URI-encoded link \${target}\`); continue; }
      const candidate = path.resolve(root, path.dirname(p), target);
      if (!candidate.startsWith(root + path.sep) && candidate !== root) {
        failures.push(\`\${p}: link escapes repository: \${target}\`);
      } else if (!fs.existsSync(candidate)) {
        failures.push(\`\${p}: missing target \${target}\`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('current guides identify the actual package version; historical reports are not rewritten', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const p of ['README.md', 'README.ru.md', 'CHANGELOG.md', 'CHANGELOG.ru.md']) {
    assert.match(fs.readFileSync(path.join(root, p), 'utf8'), new RegExp(pkg.version.replaceAll('.', '\\.')),
      \`\${p} should mention package version \${pkg.version}\`);
  }
  assert.match(fs.readFileSync(path.join(root, 'VERIFICATION.md'), 'utf8'),
    /0\.1\.0/, 'Historical verification stays labeled as 0.1.0');
});
