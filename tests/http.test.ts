import { describe, expect, test } from 'bun:test';

import type { ManifestJSEntry } from '../src/manifest.js';
import { cacheControlForEntry, etagForEntry, responseHeadersForEntry } from '../src/http.js';

function mkEntry(overrides: Partial<ManifestJSEntry> = {}): ManifestJSEntry {
  return {
    type: 'js',
    mime: 'application/javascript',
    immutable: true,
    url: '/assets/app.js',
    path: 'app.js',
    sha256: 'abcDEF123-_',
    size: 128,
    ...overrides,
  };
}

describe('etagForEntry', () => {
  test('quotes the content hash', () => {
    expect(etagForEntry(mkEntry())).toBe('"abcDEF123-_"');
  });
});

describe('responseHeadersForEntry', () => {
  test('includes content type, cache, length, and etag by default', () => {
    expect(responseHeadersForEntry(mkEntry())).toEqual({
      'Content-Type': 'application/javascript',
      'Cache-Control': cacheControlForEntry(mkEntry()),
      'Content-Length': '128',
      'ETag': '"abcDEF123-_"',
    });
  });

  test('uses the compressed variant size for encoded responses', () => {
    const entry = mkEntry({ compressed: { br: { path: 'app.js.br', size: 40 } } });
    const headers = responseHeadersForEntry(entry, { encoding: 'br' });
    expect(headers['Content-Encoding']).toBe('br');
    expect(headers['Vary']).toBe('Accept-Encoding');
    expect(headers['Content-Length']).toBe('40');
  });

  test('falls back to entry size when the variant is untracked', () => {
    const headers = responseHeadersForEntry(mkEntry(), { encoding: 'gzip' });
    expect(headers['Content-Length']).toBe('128');
  });

  test('supports opt-outs and header overrides', () => {
    const entry = mkEntry({ headers: { 'Cache-Control': 'no-store' } });
    const headers = responseHeadersForEntry(entry, { contentLength: false, etag: false });
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Length']).toBeUndefined();
    expect(headers['ETag']).toBeUndefined();
  });
});
