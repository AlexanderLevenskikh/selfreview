/**
 * Parse unified patches as data. The parser never applies a patch or opens a path.
 * Invalid or unsupported patches are returned with errors, never as an empty pass.
 */

const MAX_DIFF_BYTES = 8 * 1024 * 1024;

function quotedPath(token) {
  if (!token.startsWith('"')) return token;
  const chunks = [];
  let plain = '';
  let ended = false;
  const flush = () => {
    if (plain) chunks.push(Buffer.from(plain, 'utf8'));
    plain = '';
  };
  const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' };
  for (let i = 1; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '"') {
      if (token.slice(i + 1).trim()) throw new Error('Unexpected text after a quoted path');
      ended = true;
      break;
    }
    if (ch !== '\\') {
      plain += ch;
      continue;
    }
    i += 1;
    if (i >= token.length) throw new Error('Unterminated path escape');
    const escaped = token[i];
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(token[i + 1] ?? 'x')) octal += token[++i];
      const byte = Number.parseInt(octal, 8);
      if (byte > 255) throw new Error('Invalid octal path escape');
      flush();
      chunks.push(Buffer.from([byte]));
    } else if (Object.hasOwn(escapes, escaped)) {
      plain += escapes[escaped];
    } else {
      throw new Error('Unsupported path escape');
    }
  }
  if (!ended) throw new Error('Unterminated quoted path');
  flush();
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function tokenEnd(value) {
  if (!value.startsWith('"')) return value.indexOf(' ');
  let escaped = false;
  for (let i = 1; i < value.length; i += 1) {
    if (escaped) escaped = false;
    else if (value[i] === '\\') escaped = true;
    else if (value[i] === '"') return i + 1;
  }
  return -1;
}

function gitHeaderPaths(value) {
  if (value.startsWith('"')) {
    const end = tokenEnd(value);
    if (end < 0) throw new Error('Malformed quoted diff header');
    const remainder = value.slice(end).trimStart();
    if (!remainder) throw new Error('Missing new path in diff header');
    return [value.slice(0, end), remainder];
  }
  const split = value.indexOf(' b/');
  if (split >= 0 && value.indexOf(' b/', split + 1) < 0) {
    return [value.slice(0, split), value.slice(split + 1)];
  }
  const quotedSplit = value.indexOf(' "b/');
  if (quotedSplit >= 0) return [value.slice(0, quotedSplit), value.slice(quotedSplit + 1)];
  // ---/+++ or rename headers may disambiguate unusual unquoted filenames later.
  return null;
}

function safePath(value, prefix, allowTimestamp = false) {
  let token = value;
  if (allowTimestamp && !token.startsWith('"')) token = token.split('\t', 1)[0];
  const decoded = quotedPath(token);
  if (decoded === '/dev/null') return null;
  let result = decoded;
  if (prefix && result.startsWith(`${prefix}/`)) result = result.slice(2);
  if (!result || result.startsWith('/') || result.includes(':')
    || /[\\\x00-\x1f\x7f]/u.test(result)
    || result.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe or non-portable patch path');
  }
  return result;
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/**
 * @returns {{files: Array, errors: string[], warnings: string[]}}
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string') throw new TypeError('Unified diff must be a string');
  const files = [];
  const errors = [];
  const warnings = [];
  if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES) {
    return { files, errors: ['Diff exceeds the 8 MiB parsing limit'], warnings };
  }
  if (!text.trim()) return { files, errors, warnings };
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let current = null;
  let hunk = null;
  let sawHeader = false;
  let sawUnrecognizedPreamble = false;
  let binaryPayload = false;
  const report = (line, message) => errors.push(`Patch line ${line}: ${message}`);

  function newFile(line) {
    return {
      oldPath: null, newPath: null, addedLines: [], touchedRanges: [],
      newLineContent: [], deleted: false, _line: line, _hunks: 0,
      _oldHeader: false, _newHeader: false, _metadata: false,
      _previousOldEnd: -1, _previousNewEnd: -1,
    };
  }

  function finishHunk(line) {
    if (!hunk) return;
    if (hunk.oldRead !== hunk.oldCount || hunk.newRead !== hunk.newCount) {
      report(line, `Truncated hunk: expected ${hunk.oldCount}/${hunk.newCount} old/new lines, received ${hunk.oldRead}/${hunk.newRead}`);
    }
    hunk = null;
  }

  function finishFile(line) {
    finishHunk(line);
    if (!current) return;
    if (!current.oldPath && !current.newPath) report(current._line, 'Missing file paths');
    if (current._oldHeader !== current._newHeader) report(current._line, 'Missing --- or +++ file header');
    if (current._hunks > 0 && (!current._oldHeader || !current._newHeader)) report(current._line, 'Hunks require both --- and +++ file headers');
    if (!current._hunks && !current._metadata && !current.binary) report(current._line, 'File change contains no hunks or change metadata');
    current.deleted = (current._newHeader || current._deletedMetadata) && current.newPath === null;
    current.metadataOnly = current._hunks === 0 && current._metadata && !current.binary;
    current.addedLines = [...new Set(current.addedLines)].sort((a, b) => a - b);
    current.touchedRanges = mergeRanges(current.touchedRanges);
    const contents = new Map();
    for (const entry of current.newLineContent) {
      if (contents.has(entry.line) && contents.get(entry.line) !== entry.text) report(current._line, 'Conflicting new-side context for the same line');
      contents.set(entry.line, entry.text);
    }
    current.newLineContent = [...contents].sort((a, b) => a[0] - b[0]).map(([number, content]) => ({ line: number, text: content }));
    for (const key of Object.keys(current)) if (key.startsWith('_')) delete current[key];
    files.push(current);
    current = null;
    binaryPayload = false;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;

    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ') || line.startsWith('@@@')) {
      report(number, 'Combined diffs are unsupported; provide a two-way unified diff');
      finishHunk(number);
      continue;
    }

    if (hunk) {
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) {
        finishHunk(number);
        // Re-process the structural line outside the hunk below.
      } else if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
        const marker = line[0];
        const consumesOld = marker !== '+';
        const consumesNew = marker !== '-';
        if ((consumesOld && hunk.oldRead >= hunk.oldCount) || (consumesNew && hunk.newRead >= hunk.newCount)) {
          report(number, 'Hunk has more content than its declared line counts');
        }
        const newLine = hunk.newStart + hunk.newRead;
        if (consumesNew) current.newLineContent.push({ line: newLine, text: line.slice(1) });
        if (marker === '+') {
          current.addedLines.push(newLine);
          current.touchedRanges.push({ start: Math.max(1, newLine), end: Math.max(1, newLine) });
        } else if (marker === '-') {
          // Deletion-only hunks use the surviving new-side anchor, never line zero.
          const lastNewLine = hunk.newCount > 0 ? hunk.newStart + hunk.newCount - 1 : hunk.newStart;
          const anchor = Math.max(1, Math.min(newLine, lastNewLine));
          current.touchedRanges.push({ start: anchor, end: anchor });
        }
        if (consumesOld) hunk.oldRead += 1;
        if (consumesNew) hunk.newRead += 1;
        if (hunk.oldRead === hunk.oldCount && hunk.newRead === hunk.newCount) finishHunk(number);
        continue;
      } else {
        report(number, 'Invalid hunk line: expected a space, +, -, or newline marker');
        finishHunk(number);
      }
    }

    if (line.startsWith('diff --git ')) {
      finishFile(number);
      current = newFile(number);
      sawHeader = true;
      try {
        const paths = gitHeaderPaths(line.slice(11));
        if (paths) {
          const oldRaw = safePath(paths[0], null);
          const newRaw = safePath(paths[1], null);
          current._prefixMode = oldRaw?.startsWith('a/') && newRaw?.startsWith('b/') ? 'git' : 'none';
          current.oldPath = current._prefixMode === 'git' ? oldRaw.slice(2) : oldRaw;
          current.newPath = current._prefixMode === 'git' ? newRaw.slice(2) : newRaw;
        }
      } catch (error) { report(number, error.message); }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!current || current._oldHeader) {
        finishFile(number);
        current = newFile(number);
      }
      sawHeader = true;
      current._oldHeader = true;
      try { current.oldPath = safePath(line.slice(4), null, true); }
      catch (error) { report(number, error.message); }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current || !current._oldHeader || current._newHeader) {
        report(number, 'Unexpected +++ header');
        if (!current) current = newFile(number);
      }
      current._newHeader = true;
      try {
        current.newPath = safePath(line.slice(4), null, true);
        const hasGitPair = (current.oldPath === null || current.oldPath.startsWith('a/'))
          && (current.newPath === null || current.newPath.startsWith('b/'));
        if (current._prefixMode !== 'none' && hasGitPair) {
          if (current.oldPath !== null) current.oldPath = safePath(current.oldPath, 'a');
          if (current.newPath !== null) current.newPath = safePath(current.newPath, 'b');
        }
      }
      catch (error) { report(number, error.message); }
      continue;
    }
    if (line.startsWith('@@')) {
      if (!current) {
        report(number, 'Hunk has no file header');
        continue;
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
      if (!match) {
        report(number, 'Malformed hunk header');
        continue;
      }
      const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if ([oldStart, oldCount, newStart, newCount].some(value => !Number.isSafeInteger(value) || value > 100_000_000)
        || (oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)
        || (oldCount === 0 && newCount === 0)) {
        report(number, 'Invalid hunk range');
        continue;
      }
      if (oldStart < current._previousOldEnd || newStart < current._previousNewEnd) report(number, 'Overlapping or out-of-order hunks');
      current._previousOldEnd = oldStart + oldCount;
      current._previousNewEnd = newStart + newCount;
      current._hunks += 1;
      hunk = { oldStart, oldCount, newStart, newCount, oldRead: 0, newRead: 0 };
      continue;
    }
    if (current && /^(?:rename|copy) (?:from|to) /u.test(line)) {
      const match = /^(?:rename|copy) (from|to) (.*)$/u.exec(line);
      current._metadata = true;
      try { current[match[1] === 'from' ? 'oldPath' : 'newPath'] = safePath(match[2], null); }
      catch (error) { report(number, error.message); }
      continue;
    }
    if (current && /^(?:old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index) /u.test(line)) {
      current._metadata = true;
      if (line.startsWith('new file mode')) current.oldPath = null;
      if (line.startsWith('deleted file mode')) { current.newPath = null; current._deletedMetadata = true; }
      continue;
    }
    if (current && (line.startsWith('Binary files ') || line === 'GIT binary patch')) {
      current.binary = true;
      binaryPayload = line === 'GIT binary patch';
      report(number, 'Binary patch content cannot be verified as source text');
      continue;
    }
    if (binaryPayload) continue;
    if (line === '\\ No newline at end of file' || !line.trim()) continue;
    if (current && /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/u.test(line)) continue;
    if (current && /^[ +-]/u.test(line)) {
      report(number, 'Unexpected content outside a hunk');
      continue;
    }
    if (!current) sawUnrecognizedPreamble = true;
    else report(number, 'Unrecognized patch metadata');
  }
  finishFile(lines.length + 1);
  if (!sawHeader) errors.push('No unified diff file headers found');
  else if (sawUnrecognizedPreamble) warnings.push('Text before the first file diff was ignored');
  const targets = new Set();
  for (const file of files) {
    const key = file.newPath ?? `deleted:${file.oldPath}`;
    if (targets.has(key)) errors.push(`Duplicate file section for ${key}`);
    targets.add(key);
  }
  return { files, errors, warnings };
}
