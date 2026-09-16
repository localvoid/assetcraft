import { describe, expect, test } from 'bun:test';

import { isCompressible } from '../src/compress.js';

describe('isCompressible', () => {
  test('compresses text-like types including wasm', () => {
    for (const type of ['js', 'wasm', 'html', 'css', 'svg', 'text', 'sourcemap'] as const) {
      expect(isCompressible({ type, mime: 'application/octet-stream' })).toBe(true);
    }
  });

  test('skips already-compressed media by default', () => {
    for (const type of ['font', 'image', 'audio', 'video', 'compression-dictionary'] as const) {
      expect(isCompressible({ type, mime: 'application/octet-stream' })).toBe(false);
    }
  });

  test('binary defers to text-like mimes', () => {
    expect(isCompressible({ type: 'binary', mime: 'application/json' })).toBe(true);
    expect(isCompressible({ type: 'binary', mime: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isCompressible({ type: 'binary', mime: 'image/svg+xml' })).toBe(true);
    expect(isCompressible({ type: 'binary', mime: 'application/octet-stream' })).toBe(false);
    expect(isCompressible({ type: 'binary', mime: 'image/png' })).toBe(false);
  });
});
