import { describe, expect, test } from 'bun:test';

import type { ManifestEntry, ManifestJSEntry } from '../../src/manifest.js';
import { diffManifests, isEqualManifestEntry } from '../../src/manifest/diff.js';

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

describe('diffManifests', () => {
  test('empty manifests produce empty diff', () => {
    expect(diffManifests([], [])).toEqual({ added: [], removed: [], changed: [], unchanged: [] });
  });

  test('reports added entries in next order', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const b = mkEntry({ path: 'b.js', sha256: 'bbb' });
    const diff = diffManifests([], [a, b]);
    expect(diff.added).toEqual([a, b]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  test('reports removed entries in prev order', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const b = mkEntry({ path: 'b.js', sha256: 'bbb' });
    const diff = diffManifests([a, b], []);
    expect(diff.removed).toEqual([a, b]);
    expect(diff.added).toEqual([]);
  });

  test('identical entries are unchanged', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const b = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const diff = diffManifests([a], [b]);
    expect(diff.unchanged).toEqual([b]);
    expect(diff.changed).toEqual([]);
  });

  test('same reference is unchanged', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const diff = diffManifests([a], [a]);
    expect(diff.unchanged).toEqual([a]);
  });

  test('hash change is reported with hashChanged true', () => {
    const prev = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const next = mkEntry({ path: 'a.js', sha256: 'bbb' });
    const diff = diffManifests([prev], [next]);
    expect(diff.changed).toEqual([{ prev, next, hashChanged: true }]);
    expect(diff.unchanged).toEqual([]);
  });

  test('metadata-only change is reported with hashChanged false', () => {
    const prev = mkEntry({ path: 'a.js', sha256: 'aaa', mime: 'application/javascript' });
    const next = mkEntry({ path: 'a.js', sha256: 'aaa', mime: 'text/javascript' });
    const diff = diffManifests([prev], [next]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.hashChanged).toBe(false);
    expect(diff.changed[0]?.prev).toBe(prev);
    expect(diff.changed[0]?.next).toBe(next);
  });

  test('mixed diff keeps next order for changed/unchanged and prev order for removed', () => {
    const keep = mkEntry({ path: 'keep.js', sha256: 'k' });
    const oldChanged = mkEntry({ path: 'changed.js', sha256: 'old' });
    const gone1 = mkEntry({ path: 'gone1.js', sha256: 'g1' });
    const gone2 = mkEntry({ path: 'gone2.js', sha256: 'g2' });
    const nextChanged = mkEntry({ path: 'changed.js', sha256: 'new' });
    const added = mkEntry({ path: 'added.js', sha256: 'a' });
    const diff = diffManifests([keep, oldChanged, gone1, gone2], [nextChanged, keep, added]);
    expect(diff.added).toEqual([added]);
    expect(diff.removed).toEqual([gone1, gone2]);
    expect(diff.unchanged).toEqual([keep]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.next).toBe(nextChanged);
  });
});

describe('isEqualManifestEntry', () => {
  test('same reference is equal', () => {
    const e = mkEntry({ path: 'a.js', sha256: 'aaa' });
    expect(isEqualManifestEntry(e, e)).toBe(true);
  });

  test('structurally equal entries are equal', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa', name: 'app', tags: ['x'] });
    const b = { ...a, tags: [...(a.tags ?? [])] };
    expect(isEqualManifestEntry(a, b)).toBe(true);
  });

  test('detects scalar field differences', () => {
    const base = mkEntry({ path: 'a.js', sha256: 'aaa' });
    expect(isEqualManifestEntry(base, { ...base, type: 'css' as const })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, mime: 'text/css' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, immutable: true })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, path: 'b.js' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, sha256: 'zzz' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, url: '/other.js' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, size: base.size + 1 })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, integrity: 'sha384-abc' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, crossorigin: 'anonymous' })).toBe(false);
  });

  test('treats string and object urls with same value as equal', () => {
    const a = mkEntry({ path: 'a.js', sha256: 'aaa', url: 'https://cdn.example/a.js' });
    const b = mkEntry({
      path: 'a.js',
      sha256: 'aaa',
      url: { origin: 'https://cdn.example', path: '/a.js' },
    });
    expect(isEqualManifestEntry(a, b)).toBe(true);
  });

  test('detects name, tags, and headers differences', () => {
    const base = mkEntry({
      path: 'a.js',
      sha256: 'aaa',
      name: 'app',
      tags: ['a'],
      headers: { 'cache-control': 'max-age=1' },
    });
    expect(isEqualManifestEntry(base, { ...base, name: 'other' })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, tags: ['b'] })).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, headers: { 'cache-control': 'max-age=2' } })).toBe(
      false,
    );
    // undefined vs missing-equivalent value is not equal
    expect(isEqualManifestEntry(base, { ...base, name: undefined })).toBe(false);
  });

  test('detects preload differences structurally', () => {
    const base = mkEntry({ path: 'a.js', sha256: 'aaa' });
    const withPreload = {
      ...base,
      preload: [{ url: '/assets/hero.png', as: 'image' }],
    };
    expect(isEqualManifestEntry(base, withPreload)).toBe(false);
    expect(isEqualManifestEntry(withPreload, { ...withPreload })).toBe(true);
    expect(
      isEqualManifestEntry(withPreload, {
        ...withPreload,
        preload: [{ url: '/assets/hero.png', as: 'image' }],
      }),
    ).toBe(true);
    expect(
      isEqualManifestEntry(withPreload, {
        ...withPreload,
        preload: [{ url: '/assets/other.png', as: 'image' }],
      }),
    ).toBe(false);
  });

  test('detects compressed and per-type metadata differences', () => {
    const base = mkEntry({ path: 'a.js', sha256: 'aaa' });
    expect(
      isEqualManifestEntry(base, {
        ...base,
        compressed: { br: { path: 'a.js.br', size: 10, sha256: 'xyz' } },
      }),
    ).toBe(false);
    expect(isEqualManifestEntry(base, { ...base, deps: ['/assets/dep.js'] })).toBe(false);
    const withDeps = { ...base, deps: ['/assets/dep.js'] };
    expect(isEqualManifestEntry(withDeps, { ...withDeps, deps: ['/assets/dep.js'] })).toBe(true);
  });

  test('compares compression-dictionary match fields', () => {
    const base: ManifestEntry = {
      ...mkEntry({ path: 'dict.dat', sha256: 'ddd' }),
      type: 'compression-dictionary' as const,
      match: '*.js',
      matchDest: '/dict.br',
    };
    const same: ManifestEntry = { ...base };
    expect(isEqualManifestEntry(base, same)).toBe(true);
    expect(
      isEqualManifestEntry(base, {
        ...base,
        type: 'compression-dictionary' as const,
        match: '*.css',
      }),
    ).toBe(false);
    expect(
      isEqualManifestEntry(base, {
        ...base,
        type: 'compression-dictionary' as const,
        matchDest: '/other.br',
      }),
    ).toBe(false);
    // matchDest present vs absent is a difference
    expect(
      isEqualManifestEntry(base, {
        ...base,
        type: 'compression-dictionary' as const,
        matchDest: undefined,
      }),
    ).toBe(false);
  });
});
