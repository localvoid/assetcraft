import { describe, expect, test } from 'bun:test';

import { calculateHash } from '../../src/file.js';
import { createManifestEntry } from '../../src/manifest/entry.js';
import { validateManifestEntry } from '../../src/manifest/validate.js';

describe('createManifestEntry', () => {
  test('hashes, sizes, and names the entry', async () => {
    const content = 'console.log("hello");';
    const { entry, variants } = await createManifestEntry({
      type: 'js',
      mime: 'application/javascript',
      content,
      path: 'assets/app.js',
    });
    expect(entry.type).toBe('js');
    expect(entry.sha256).toBe(calculateHash(content));
    expect(entry.size).toBe(Buffer.byteLength(content));
    expect(entry.immutable).toBe(true);
    expect(entry.path).toMatch(/^assets\/app-[A-Za-z0-9_-]{12}\.js$/);
    expect(entry.url).toBe(`/${entry.path}`);
    expect(entry.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+={0,2}$/);
    expect(variants).toEqual({});
    expect(entry.compressed).toBeUndefined();
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('respects immutable, pathHash, integrity, and url overrides', async () => {
    const { entry } = await createManifestEntry({
      type: 'css',
      mime: 'text/css',
      content: 'body{}',
      path: 'assets/style.css',
      url: 'https://cdn.example/assets/style.css',
      immutable: false,
      pathHash: false,
      integrity: false,
      name: 'style',
      tags: ['app'],
      crossorigin: 'anonymous',
      fetchPriority: 'high',
      preload: [{ url: '/assets/hero.png', as: 'image' }],
      extra: { media: 'screen' },
    });
    expect(entry.immutable).toBeUndefined();
    expect(entry.path).toBe('assets/style.css');
    expect(entry.url).toBe('https://cdn.example/assets/style.css');
    expect(entry.integrity).toBeUndefined();
    expect(entry.name).toBe('style');
    expect(entry.crossorigin).toBe('anonymous');
    expect(entry.media).toBe('screen');
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('compresses content and records variant metadata', async () => {
    const { entry, variants } = await createManifestEntry({
      type: 'js',
      mime: 'application/javascript',
      content: 'a'.repeat(4096),
      path: 'assets/app.js',
      compress: true,
    });
    expect(Object.keys(variants).length).toBeGreaterThan(0);
    expect(entry.compressed).toBeDefined();
    const suffixes = { br: '.br', zstd: '.zst', gzip: '.gz' } as const;
    for (const [format, data] of Object.entries(variants)) {
      const key = format as keyof typeof suffixes;
      const meta = entry.compressed?.[key];
      expect(meta?.path).toBe(`${entry.path}${suffixes[key]}`);
      expect(meta?.size).toBe((data as Buffer).length);
      expect(meta?.sha256).toBe(calculateHash(data as Buffer));
    }
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('supports custom hash length and suffixes', async () => {
    const { entry, variants } = await createManifestEntry({
      type: 'text',
      mime: 'application/json',
      content: 'b'.repeat(4096),
      path: 'data/strings.json',
      pathHash: 8,
      compress: true,
      compressSuffixes: { gzip: '.gzip' },
      extra: { charset: 'utf-8' },
    });
    expect(entry.path).toMatch(/^data\/strings-[A-Za-z0-9_-]{8}\.json$/);
    if (variants.gzip !== undefined) {
      expect(entry.compressed?.gzip?.path).toBe(`${entry.path}.gzip`);
    }
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('builds compression-dictionary entries with match', async () => {
    const { entry } = await createManifestEntry({
      type: 'compression-dictionary',
      mime: 'application/octet-stream',
      content: 'dictionary-content',
      path: 'dicts/app.dict',
      extra: { match: '*.js' },
    });
    expect(entry.match).toBe('*.js');
    expect(validateManifestEntry(entry)).toEqual([]);
  });
});
