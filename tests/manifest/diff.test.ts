import { describe, expect, test } from 'bun:test';

import type { ManifestJSEntry } from '../../src/manifest.js';
import { diffManifests } from '../../src/manifest/diff.js';

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

  test('string vs object urls are not normalized', () => {
    const prev = mkEntry({ path: 'a.js', sha256: 'aaa', url: 'https://cdn.example/a.js' });
    const next = mkEntry({
      path: 'a.js',
      sha256: 'aaa',
      url: { origin: 'https://cdn.example', path: '/a.js' },
    });
    const diff = diffManifests([prev], [next]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.unchanged).toEqual([]);
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


