import { describe, expect, test } from 'bun:test';

import type { ManifestEntry } from '../../src/manifest.js';
import { calculateHash } from '../../src/file.js';
import { createManifestEntry, createPathFormatter } from '../../src/manifest/entry.js';
import { validateManifestEntry } from '../../src/manifest/validate.js';

describe('createManifestEntry', () => {
  test('hashes, sizes, and keeps the path as-is', async () => {
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
    expect(entry.path).toBe('assets/app.js');
    expect(entry.url).toBe(`/${entry.path}`);
    expect(entry.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+={0,2}$/);
    expect(variants).toEqual({});
    expect(entry.compressed).toBeUndefined();
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('respects immutable, integrity, and url overrides', async () => {
    const { entry } = await createManifestEntry({
      type: 'css',
      mime: 'text/css',
      content: 'body{}',
      path: 'assets/style.css',
      url: 'https://cdn.example/assets/style.css',
      immutable: false,
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
    const suffixes = { br: '.br', zst: '.zst', gz: '.gz' } as const;
    for (const [format, data] of Object.entries(variants)) {
      const key = format as keyof typeof suffixes;
      const meta = entry.compressed?.[key];
      expect(meta?.path).toBe(`${entry.path}${suffixes[key]}`);
      expect(meta?.size).toBe((data as Buffer).length);
      expect(meta?.sha256).toBe(calculateHash(data as Buffer));
    }
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('accepts a pre-formatted hashed path', async () => {
    const content = 'b'.repeat(4096);
    const sha256 = calculateHash(content);
    const formatPath = createPathFormatter({ hash: 8 });
    const path = formatPath({ path: 'data/strings.json' } as ManifestEntry, sha256);
    expect(path).toMatch(/^data\/strings-[A-Za-z0-9_-]{8}\.json$/);
    const { entry, variants } = await createManifestEntry({
      type: 'text',
      mime: 'application/json',
      content,
      path,
      compress: true,
      extra: { charset: 'utf-8' },
    });
    expect(entry.path).toBe(path);
    if (variants.gz !== undefined) {
      expect(entry.compressed?.gz?.path).toBe(`${entry.path}.gz`);
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

describe('createPathFormatter', () => {
  const stub = (path: string) => ({ path }) as ManifestEntry;

  test('inserts a 12-char hash by default, keeping the directory', () => {
    const formatPath = createPathFormatter();
    expect(formatPath(stub('assets/app.js'), 'a1b2c3d4e5f6g7h8')).toBe(
      'assets/app-a1b2c3d4e5f6.js',
    );
  });

  test('supports a custom hash length', () => {
    const formatPath = createPathFormatter({ hash: 8 });
    expect(formatPath(stub('data/strings.json'), 'a1b2c3d4e5f6')).toBe(
      'data/strings-a1b2c3d4.json',
    );
  });

  test('replaces the directory when dir is given', () => {
    const formatPath = createPathFormatter({ dir: 'assets', hash: 8 });
    expect(formatPath(stub('src/app.js'), 'a1b2c3d4e5f6')).toBe('assets/app-a1b2c3d4.js');
  });

  test('handles extensionless files', () => {
    const formatPath = createPathFormatter({ hash: 4 });
    expect(formatPath(stub('dicts/app'), 'abcd1234')).toBe('dicts/app-abcd');
  });

  test('hash: 0 applies only the dir remap', () => {
    const formatPath = createPathFormatter({ dir: 'static', hash: 0 });
    expect(formatPath(stub('src/app.js'), 'a1b2c3d4')).toBe('static/app.js');
  });
});
