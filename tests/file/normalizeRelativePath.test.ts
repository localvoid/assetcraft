import { describe, expect, test } from 'bun:test';

import type { InvalidKeepPathReason } from '../../src/file.js';
import { normalizeRelativePath } from '../../src/file.js';

describe('normalizeRelativePath', () => {
  const valid: [string, string][] = [
    ['a.js', 'a.js'],
    ['./a.js', 'a.js'],
    ['a//b.js', 'a/b.js'],
    ['a/./b.js', 'a/b.js'],
    ['x/../a.js', 'a.js'],
    ['sub/../sub/c.js', 'sub/c.js'],
    ['sub/', 'sub'],
    ['./sub/', 'sub'],
    ['a/b/c', 'a/b/c'],
  ];
  for (const [input, want] of valid) {
    test(`normalizes '${input}' to '${want}'`, () => {
      expect(normalizeRelativePath(input)).toEqual({ ok: true, path: want });
    });
  }

  const invalid: [string, InvalidKeepPathReason][] = [
    ['', 'empty'],
    ['/abs.js', 'absolute'],
    ['C:\\win.js', 'absolute'],
    ['.', 'self'],
    ['./', 'self'],
    ['a/..', 'self'],
    ['..', 'escape'],
    ['../x.js', 'escape'],
    ['a/../../x.js', 'escape'],
  ];
  for (const [input, reason] of invalid) {
    test(`rejects '${input}' as ${reason}`, () => {
      expect(normalizeRelativePath(input)).toEqual({ ok: false, reason });
    });
  }
});
