import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/diff.mjs';

test('unified diff keeps context and added lines for stale-snapshot checks', () => {
  const result = parseUnifiedDiff('diff --git a/src/a.ts b/src/a.ts\nindex 123..456 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n export function a() {\n-  var x = 1;\n+  const x = 1;\n+  return x;\n }\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.files[0].newPath, 'src/a.ts');
  assert.deepEqual(result.files[0].addedLines, [2, 3]);
  assert.deepEqual(result.files[0].touchedRanges, [{ start: 2, end: 3 }]);
  assert.deepEqual(result.files[0].newLineContent, [
    { line: 1, text: 'export function a() {' },
    { line: 2, text: '  const x = 1;' },
    { line: 3, text: '  return x;' },
    { line: 4, text: '}' },
  ]);
});

test('deletion-only zero-context diff retains a positive new-side anchor', () => {
  const result = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -2 +1,0 @@\n-const removed = 1;\n');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files[0].addedLines, []);
  assert.deepEqual(result.files[0].touchedRanges, [{ start: 1, end: 1 }]);
});

test('deletion at EOF anchors to the surviving new-side line rather than one past EOF', () => {
  const result = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1 @@\n keep\n-removed\n');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files[0].touchedRanges, [{ start: 1, end: 1 }]);
});

test('new and deleted files are represented without phantom sources', () => {
  const result = parseUnifiedDiff('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export {};\ndiff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export {};\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].oldPath, null);
  assert.equal(result.files[0].deleted, false);
  assert.equal(result.files[1].newPath, null);
  assert.equal(result.files[1].deleted, true);
});

test('rename-only and mode-only changes retain paths and declare metadataOnly', () => {
  const result = parseUnifiedDiff('diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts\ndiff --git a/script.js b/script.js\nold mode 100644\nnew mode 100755\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.files[0].oldPath, 'old name.ts');
  assert.equal(result.files[0].newPath, 'new name.ts');
  assert.equal(result.files[0].metadataOnly, true);
  assert.equal(result.files[1].metadataOnly, true);
});

test('unprefixed paths beginning with b/ are not silently redirected to a sibling', () => {
  const result = parseUnifiedDiff('diff --git b/file.ts b/file.ts\n--- b/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.files[0].oldPath, 'b/file.ts');
  assert.equal(result.files[0].newPath, 'b/file.ts');
});

test('quoted UTF-8 octal Git paths and spaces are decoded without shell evaluation', () => {
  const result = parseUnifiedDiff('diff --git "a/\\321\\202\\320\\265\\321\\201\\321\\202 name.ts" "b/\\321\\202\\320\\265\\321\\201\\321\\202 name.ts"\n--- "a/\\321\\202\\320\\265\\321\\201\\321\\202 name.ts"\n+++ "b/\\321\\202\\320\\265\\321\\201\\321\\202 name.ts"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.files[0].newPath, 'тест name.ts');
});

test('hunk content beginning with file-header markers is still source text', () => {
  const result = parseUnifiedDiff('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n---- old markdown\n++++ new markdown\n');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files[0].newLineContent, [{ line: 1, text: '+++ new markdown' }]);
});

test('truncated and excess hunk counts cannot become a clean result', () => {
  const truncated = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n');
  assert.ok(truncated.errors.some(error => error.includes('Truncated hunk')));
  const excess = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n+extra\n');
  assert.ok(excess.errors.length > 0);
});

test('unsafe paths are rejected before a caller considers reading them', () => {
  for (const target of ['../secret.ts', 'src/../../secret.ts', '/etc/passwd', 'C:/secret.ts', 'src\\secret.ts', './file.ts']) {
    const result = parseUnifiedDiff(`--- a/ok.ts\n+++ ${target}\n@@ -1 +1 @@\n-a\n+b\n`);
    assert.ok(result.errors.some(error => error.includes('path')), target);
  }
});

test('combined, binary, malformed, overlapping, and duplicate diffs are explicit errors', () => {
  const inputs = [
    'diff --cc a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n',
    'diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\n',
    '--- a/a.ts\n+++ b/a.ts\n@@ -1,xyz +1 @@\n',
    '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+b\n',
    '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/a.ts\n+++ b/a.ts\n@@ -2 +2 @@\n-c\n+d\n',
  ];
  for (const input of inputs) assert.ok(parseUnifiedDiff(input).errors.length > 0, input);
});

test('empty diff is empty, while text without a diff is not a clean empty diff', () => {
  assert.deepEqual(parseUnifiedDiff(''), { files: [], errors: [], warnings: [] });
  assert.ok(parseUnifiedDiff('some random text').errors.length > 0);
});

test('CRLF and missing-final-newline markers preserve line count validation', () => {
  const result = parseUnifiedDiff('--- a/a.ts\r\n+++ b/a.ts\r\n@@ -1 +1 @@\r\n-a\r\n\\ No newline at end of file\r\n+b\r\n\\ No newline at end of file\r\n');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files[0].newLineContent, [{ line: 1, text: 'b' }]);
});
