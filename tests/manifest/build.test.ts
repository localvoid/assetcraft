import { describe, expect, test } from 'bun:test';

import type { ManifestEntry, ManifestJSEntry } from '../../src/manifest.js';
import {
  urlSafeSHA256,
  createManifestEntry,
  createPathFormatter,
  ManifestBuilder,
} from '../../src/manifest/build.js';
import { validateManifestEntry } from '../../src/manifest/validate.js';

let seq = 0;

interface MkOverrides {
  path: string;
  mime?: string;
  immutable?: boolean;
  url?: string | { origin: string; path: string };
  sha256?: string;
  name?: string | string[];
  tags?: string[];
  headers?: Record<string, string>;
}

function mkEntry(overrides: MkOverrides): ManifestJSEntry {
  seq += 1;
  return {
    type: 'js',
    mime: 'application/javascript',
    url: `/assets/${overrides.path}`,
    sha256: `hash-${seq}`,
    size: 100,
    ...overrides,
  };
}

describe('ManifestBuilder add', () => {
  test('appends entries in order and returns indices', () => {
    const b = new ManifestBuilder();
    const a = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const c = mkEntry({ path: 'b.js', sha256: 'bbb' });
    expect(b.add(a)).toBe(0);
    expect(b.add(c)).toBe(1);
    expect(b.entries).toEqual([a, c]);
  });

  test('indexes by path, url, and single name', () => {
    const b = new ManifestBuilder();
    const e = mkEntry({ path: 'app.js', sha256: 'aaa', name: 'app' });
    b.add(e);
    expect(b.getByPath('app.js')).toBe(e);
    expect(b.getByURL('/assets/app.js')).toBe(e);
    expect(b.getByName('app')).toBe(e);
  });

  test('indexes each name when name is an array', () => {
    const b = new ManifestBuilder();
    const e = mkEntry({ path: 'app.js', sha256: 'aaa', name: ['app', 'main'] });
    b.add(e);
    expect(b.getByName('app')).toBe(e);
    expect(b.getByName('main')).toBe(e);
  });

  test('supports object urls keyed by origin + path', () => {
    const b = new ManifestBuilder();
    const e = mkEntry({
      path: 'app.js',
      sha256: 'aaa',
      url: { origin: 'https://cdn.example', path: '/assets/app.js' },
    });
    b.add(e);
    expect(b.getByURL('https://cdn.example/assets/app.js')).toBe(e);
  });

  test('throws on duplicate path', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa' }));
    expect(() => b.add(mkEntry({ path: 'a.js', sha256: 'bbb' }))).toThrow(
      "path 'a.js' already exists",
    );
  });

  test('throws on duplicate name', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa', name: 'app' }));
    expect(() => b.add(mkEntry({ path: 'b.js', sha256: 'bbb', name: 'app' }))).toThrow(
      "name 'app' already exists",
    );
  });

  test('throws when one name of an array collides', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa', name: 'shared' }));
    expect(() =>
      b.add(mkEntry({ path: 'b.js', sha256: 'bbb', name: ['other', 'shared'] })),
    ).toThrow("name 'shared' already exists");
  });

  test('throws on url conflict with different hash', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa', url: '/same.js' }));
    expect(() => b.add(mkEntry({ path: 'b.js', sha256: 'bbb', url: '/same.js' }))).toThrow(
      "url '/same.js' already exists with a different hash",
    );
  });

  test('allows same url with same hash', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa', url: '/same.js' }));
    const second = mkEntry({ path: 'b.js', sha256: 'aaa', url: '/same.js' });
    expect(() => b.add(second)).not.toThrow();
    expect(b.getByURL('/same.js')).toBe(second);
  });
});

describe('ManifestBuilder import', () => {
  test('indexes externals without adding to entries', () => {
    const b = new ManifestBuilder();
    const ext = mkEntry({ path: 'ext.js', sha256: 'eee', name: 'ext' });
    b.import([ext]);
    expect(b.entries).toEqual([]);
    expect(b.getByPath('ext.js')).toBe(ext);
    expect(b.getByName('ext')).toBe(ext);
    expect(b.getByURL('/assets/ext.js')).toBe(ext);
  });

  test('local entries take precedence over externals', () => {
    const b = new ManifestBuilder();
    const ext = mkEntry({ path: 'shared.js', sha256: 'eee', name: 'shared' });
    b.import([ext]);
    const local = mkEntry({ path: 'local.js', sha256: 'lll', name: 'shared' });
    b.add(local);
    expect(b.getByName('shared')).toBe(local);
    // path and url lookups still resolve externals when not shadowed locally
    expect(b.getByPath('shared.js')).toBe(ext);
  });

  test('local url shadows external url with same key', () => {
    const b = new ManifestBuilder();
    const ext = mkEntry({ path: 'ext.js', sha256: 'eee', url: '/x.js' });
    b.import([ext]);
    const local = mkEntry({ path: 'local.js', sha256: 'lll', url: '/y.js' });
    b.add(local);
    expect(b.getByURL('/x.js')).toBe(ext);
    expect(b.getByURL('/y.js')).toBe(local);
  });

  test('throws on duplicate external path', () => {
    const b = new ManifestBuilder();
    b.import([mkEntry({ path: 'a.js', sha256: 'aaa' })]);
    expect(() => b.import([mkEntry({ path: 'a.js', sha256: 'bbb' })])).toThrow(
      "path 'a.js' already exists",
    );
  });

  test('throws on duplicate external name', () => {
    const b = new ManifestBuilder();
    b.import([mkEntry({ path: 'a.js', sha256: 'aaa', name: 'dup' })]);
    expect(() => b.import([mkEntry({ path: 'b.js', sha256: 'bbb', name: 'dup' })])).toThrow(
      "name 'dup' already exists",
    );
  });

  test('throws on external url conflict with different hash', () => {
    const b = new ManifestBuilder();
    b.import([mkEntry({ path: 'a.js', sha256: 'aaa', url: '/same.js' })]);
    expect(() => b.import([mkEntry({ path: 'b.js', sha256: 'bbb', url: '/same.js' })])).toThrow(
      "url '/same.js' already exists",
    );
  });
});

describe('ManifestBuilder upsert', () => {
  test('adds when path is missing', () => {
    const b = new ManifestBuilder();
    const e = mkEntry({ path: 'a.js', sha256: 'aaa' });
    expect(b.upsert(e)).toBe(0);
    expect(b.entries).toEqual([e]);
  });

  test('replaces entry with same path keeping position', () => {
    const b = new ManifestBuilder();
    const first = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const second = mkEntry({ path: 'b.js', sha256: 'bbb' });
    b.add(first);
    b.add(second);
    const replacement = mkEntry({ path: 'a.js', sha256: 'ccc', url: '/assets/a.js' });
    expect(b.upsert(replacement)).toBe(0);
    expect(b.entries).toEqual([replacement, second]);
    expect(b.getByPath('a.js')).toBe(replacement);
  });

  test('same object reference is idempotent', () => {
    const b = new ManifestBuilder();
    const e = mkEntry({ path: 'a.js', sha256: 'aaa' });
    b.add(e);
    expect(b.upsert(e)).toBe(0);
    expect(b.entries).toEqual([e]);
  });

  test('name collision with another entry throws and leaves existing untouched', () => {
    const b = new ManifestBuilder();
    const first = mkEntry({ path: 'a.js', sha256: 'aaa', name: 'one' });
    const second = mkEntry({ path: 'b.js', sha256: 'bbb', name: 'two' });
    b.add(first);
    b.add(second);
    const bad = mkEntry({ path: 'a.js', sha256: 'ccc', name: 'two' });
    expect(() => b.upsert(bad)).toThrow("name 'two' already exists");
    expect(b.entries).toEqual([first, second]);
    expect(b.getByName('one')).toBe(first);
    expect(b.getByName('two')).toBe(second);
  });

  test('url collision with another entry throws and leaves existing untouched', () => {
    const b = new ManifestBuilder();
    const first = mkEntry({ path: 'a.js', sha256: 'aaa', url: '/a.js' });
    const second = mkEntry({ path: 'b.js', sha256: 'bbb', url: '/b.js' });
    b.add(first);
    b.add(second);
    const bad = mkEntry({ path: 'a.js', sha256: 'ccc', url: '/b.js' });
    expect(() => b.upsert(bad)).toThrow("url '/b.js' already exists");
    expect(b.entries).toEqual([first, second]);
    expect(b.getByURL('/a.js')).toBe(first);
  });

  test('frees the old name on successful replace', () => {
    const b = new ManifestBuilder();
    const first = mkEntry({ path: 'a.js', sha256: 'aaa', name: 'old' });
    b.add(first);
    b.upsert(mkEntry({ path: 'a.js', sha256: 'bbb', name: 'new' }));
    expect(b.getByName('old')).toBeUndefined();
    expect(b.getByName('new')?.path).toBe('a.js');
  });
});

describe('ManifestBuilder updateByPath', () => {
  test('throws for missing path', () => {
    const b = new ManifestBuilder();
    expect(() => b.updateByPath('nope.js')).toThrow("Missing asset 'nope.js'");
  });

  test('re-adds prev entry without transform', () => {
    const prev = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const b = new ManifestBuilder([prev]);
    expect(b.updateByPath('a.js')).toBe(0);
    expect(b.entries).toEqual([prev]);
    expect(b.getByPath('a.js')).toBe(prev);
  });

  test('applies transform before adding', () => {
    const prev = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const b = new ManifestBuilder([prev]);
    const idx = b.updateByPath('a.js', (e) => ({ ...e, sha256: 'zzz' }));
    expect(idx).toBe(0);
    expect(b.entries[0]?.sha256).toBe('zzz');
  });
});

describe('ManifestBuilder queries', () => {
  test('getByTag returns locals then unshadowed externals', () => {
    const b = new ManifestBuilder();
    const local = mkEntry({ path: 'a.js', sha256: 'aaa', tags: ['app'] });
    const shadowed = mkEntry({ path: 'a.js', sha256: 'aaa', tags: ['app'] });
    const visible = mkEntry({ path: 'ext.js', sha256: 'eee', tags: ['app'] });
    const untagged = mkEntry({ path: 'other.js', sha256: 'ooo', tags: ['x'] });
    b.add(local);
    b.import([shadowed, visible, untagged]);
    expect(b.getByTag('app')).toEqual([local, visible]);
  });

  test('getByTag returns empty array when nothing matches', () => {
    const b = new ManifestBuilder();
    b.add(mkEntry({ path: 'a.js', sha256: 'aaa' }));
    expect(b.getByTag('missing')).toEqual([]);
  });

  test('listByType returns locals then unshadowed externals', () => {
    const b = new ManifestBuilder();
    const js = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const css: ManifestEntry = { ...mkEntry({ path: 'a.css', sha256: 'ccc' }), type: 'css' };
    const extJs = mkEntry({ path: 'ext.js', sha256: 'eee' });
    b.add(js);
    b.add(css);
    b.import([extJs]);
    expect(b.listByType('js')).toEqual([js, extJs]);
    expect(b.listByType('css')).toEqual([css]);
  });

  test('listByType shadows externals with the same path', () => {
    const b = new ManifestBuilder();
    const local = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const ext = mkEntry({ path: 'a.js', sha256: 'aaa' });
    b.add(local);
    b.import([ext]);
    expect(b.listByType('js')).toEqual([local]);
  });
});

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
    expect(entry.sha256).toBe(urlSafeSHA256(content));
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
      expect(meta?.sha256).toBe(urlSafeSHA256(data as Buffer));
    }
    expect(validateManifestEntry(entry)).toEqual([]);
  });

  test('accepts a pre-formatted hashed path', async () => {
    const content = 'b'.repeat(4096);
    const sha256 = urlSafeSHA256(content);
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
