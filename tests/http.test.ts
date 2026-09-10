import { describe, expect, test } from 'bun:test';

import type { ManifestJSEntry } from '../src/manifest.js';
import {
  buildResponseHeaders,
  formatLinkHeader,
  formatPreloadLink,
  getCacheControl,
  getETag,
  getPreloadAs,
} from '../src/http.js';

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

describe('getETag', () => {
  test('quotes the content hash', () => {
    expect(getETag(mkEntry())).toBe('"abcDEF123-_"');
  });
});

describe('buildResponseHeaders', () => {
  test('includes content type, cache, length, and etag by default', () => {
    expect(buildResponseHeaders(mkEntry())).toEqual({
      'Content-Type': 'application/javascript',
      'Cache-Control': getCacheControl(mkEntry()),
      'Content-Length': '128',
      'ETag': '"abcDEF123-_"',
    });
  });

  test('uses the compressed variant size for encoded responses', () => {
    const entry = mkEntry({ compressed: { br: { path: 'app.js.br', size: 40 } } });
    const headers = buildResponseHeaders(entry, { encoding: 'br' });
    expect(headers['Content-Encoding']).toBe('br');
    expect(headers['Vary']).toBe('Accept-Encoding');
    expect(headers['Content-Length']).toBe('40');
  });

  test('falls back to entry size when the variant is untracked', () => {
    const headers = buildResponseHeaders(mkEntry(), { encoding: 'gzip' });
    expect(headers['Content-Length']).toBe('128');
  });

  test('supports opt-outs and header overrides', () => {
    const entry = mkEntry({ headers: { 'Cache-Control': 'no-store' } });
    const headers = buildResponseHeaders(entry, { contentLength: false, etag: false });
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Length']).toBeUndefined();
    expect(headers['ETag']).toBeUndefined();
  });

  test('renders Link from preload entries', () => {
    const entry = mkEntry({
      preload: [
        { url: '/assets/hero.png', as: 'image' },
        { url: '/fonts/body.woff2', as: 'font' },
      ],
    });
    const headers = buildResponseHeaders(entry);
    expect(headers['Link']).toBe(
      '</assets/hero.png>; rel=preload; as=image, ' +
        '</fonts/body.woff2>; rel=preload; as=font; crossorigin=anonymous',
    );
  });

  test('prepends generated Link before a user Link header', () => {
    const entry = mkEntry({
      headers: { Link: '</existing.css>; rel=preload; as=style' },
      preload: [{ url: '/assets/hero.png', as: 'image' }],
    });
    const headers = buildResponseHeaders(entry);
    expect(headers['Link']).toBe(
      '</assets/hero.png>; rel=preload; as=image, </existing.css>; rel=preload; as=style',
    );
  });

  test('supports Link opt-out', () => {
    const entry = mkEntry({ preload: [{ url: '/assets/hero.png', as: 'image' }] });
    const headers = buildResponseHeaders(entry, { link: false });
    expect(headers['Link']).toBeUndefined();
  });
});

describe('getPreloadAs', () => {
  test('maps entry types to Link as values', () => {
    expect(getPreloadAs('js')).toBe('script');
    expect(getPreloadAs('css')).toBe('style');
    expect(getPreloadAs('font')).toBe('font');
    expect(getPreloadAs('image')).toBe('image');
    expect(getPreloadAs('svg')).toBe('image');
    expect(getPreloadAs('audio')).toBe('audio');
    expect(getPreloadAs('video')).toBe('video');
    expect(getPreloadAs('html')).toBe('document');
    expect(getPreloadAs('wasm')).toBe('fetch');
    expect(getPreloadAs('text')).toBe('fetch');
    expect(getPreloadAs('binary')).toBe('fetch');
  });

  test('returns undefined for types without a mapping', () => {
    expect(getPreloadAs('sourcemap')).toBeUndefined();
    expect(getPreloadAs('compression-dictionary')).toBeUndefined();
  });
});

describe('formatPreloadLink', () => {
  test('renders a bare preload link', () => {
    expect(formatPreloadLink('/assets/hero.png')).toBe('</assets/hero.png>; rel=preload');
  });

  test('resolves as from the entry type with explicit as winning', () => {
    expect(formatPreloadLink('/assets/hero.png', undefined, 'image')).toBe(
      '</assets/hero.png>; rel=preload; as=image',
    );
    expect(formatPreloadLink('/assets/hero.png', { as: 'fetch' }, 'image')).toBe(
      '</assets/hero.png>; rel=preload; as=fetch',
    );
  });

  test('defaults font crossorigin to anonymous', () => {
    expect(formatPreloadLink('/fonts/body.woff2', { as: 'font' })).toBe(
      '</fonts/body.woff2>; rel=preload; as=font; crossorigin=anonymous',
    );
    expect(
      formatPreloadLink('/fonts/body.woff2', { as: 'font', crossorigin: 'use-credentials' }),
    ).toBe('</fonts/body.woff2>; rel=preload; as=font; crossorigin=use-credentials');
  });

  test('renders fetchpriority and media', () => {
    expect(
      formatPreloadLink('https://cdn.example.com/hero.avif', {
        as: 'image',
        fetchPriority: 'high',
      }),
    ).toBe('<https://cdn.example.com/hero.avif>; rel=preload; as=image; fetchpriority=high');
    expect(formatPreloadLink('/print.css', { as: 'style', media: 'print' })).toBe(
      '</print.css>; rel=preload; as=style; media=print',
    );
  });

  test('quotes media containing delimiters or whitespace', () => {
    expect(formatPreloadLink('/a.css', { media: 'screen and (max-width: 600px)' })).toBe(
      '</a.css>; rel=preload; media="screen and (max-width: 600px)"',
    );
    expect(formatPreloadLink('/a.css', { media: 'a;b' })).toBe(
      '</a.css>; rel=preload; media="a;b"',
    );
    expect(formatPreloadLink('/a.css', { media: 'a"b\\c' })).toBe(
      '</a.css>; rel=preload; media="a\\"b\\\\c"',
    );
  });
});

describe('formatLinkHeader', () => {
  test('returns undefined for missing or empty preloads', () => {
    expect(formatLinkHeader(undefined)).toBeUndefined();
    expect(formatLinkHeader([])).toBeUndefined();
  });

  test('joins preload links with ", "', () => {
    expect(
      formatLinkHeader([
        { url: '/assets/hero.png', as: 'image' },
        { url: '/fonts/body.woff2', as: 'font' },
      ]),
    ).toBe(
      '</assets/hero.png>; rel=preload; as=image, ' +
        '</fonts/body.woff2>; rel=preload; as=font; crossorigin=anonymous',
    );
  });
});
