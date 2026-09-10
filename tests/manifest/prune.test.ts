import { describe, expect, test } from 'bun:test';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Manifest, ManifestEntry } from '../../src/manifest.js';
import { collectManifestPaths, pruneDir } from '../../src/manifest/prune.js';
import { pathExists, writeFiles } from '../helpers.js';

function mkEntry(path: string): ManifestEntry {
  return {
    type: 'js',
    mime: 'application/javascript',
    immutable: true,
    url: `/assets/${path}`,
    path,
    sha256: 'abc',
    size: 3,
  };
}

/** Assert `fn` rejects, optionally matching part of the error message. */
async function rejectsWith(fn: () => Promise<unknown>, messagePart?: string): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  if (messagePart !== undefined) {
    expect((error as Error).message).toContain(messagePart);
  }
}

describe('collectManifestPaths', () => {
  test('collects normalized paths', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    const keep = collectManifestPaths([mkEntry('./a.js'), mkEntry('sub/../sub/b.js')], dir);
    expect([...keep].sort()).toEqual(['a.js', 'sub/b.js']);
  });

  test('accepts a list of manifests', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    const manifests: Manifest[] = [[mkEntry('one.js')], [mkEntry('two.js')]];
    expect([...collectManifestPaths(manifests, dir)].sort()).toEqual(['one.js', 'two.js']);
  });

  test('includes compressed variants', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    const keep = collectManifestPaths([mkEntry('app-hash.js')], dir, {
      compressedSuffixes: ['.br', '.gz'],
    });
    expect([...keep].sort()).toEqual(['app-hash.js', 'app-hash.js.br', 'app-hash.js.gz']);
  });

  for (const bad of ['', '.', './', '/abs.js', '..', '../x.js', 'a/../../x.js']) {
    test(`throws for entry '${bad}'`, async () => {
      await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
      const dir = tmp.path;
      expect(() => collectManifestPaths([mkEntry(bad)], dir)).toThrow();
    });
  }

  for (const suffix of ['', '.', '..', '/evil', 'a/b']) {
    test(`throws for suffix '${suffix}'`, async () => {
      await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
      const dir = tmp.path;
      expect(() =>
        collectManifestPaths([mkEntry('a.js')], dir, { compressedSuffixes: [suffix] }),
      ).toThrow();
    });
  }
});

describe('pruneDir', () => {
  test('keeps referenced files and removes stale ones', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'keep.js': 'keep', 'stale.js': 'stale' });
    await pruneDir(dir, [mkEntry('./keep.js')]);
    expect(await pathExists(join(dir, 'keep.js'))).toBe(true);
    expect(await pathExists(join(dir, 'stale.js'))).toBe(false);
  });

  test('keeps extra ignore paths and whole directories', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, {
      'app.js': 'app',
      'static/inner/v.js': 'v',
      'stale.js': 's',
    });
    await pruneDir(dir, [mkEntry('app.js')], { ignore: ['static/'] });
    expect(await pathExists(join(dir, 'static', 'inner', 'v.js'))).toBe(true);
    expect(await pathExists(join(dir, 'stale.js'))).toBe(false);
  });

  test('absolute ignore throws and deletes nothing', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'keep.js': 'keep' });
    await rejectsWith(
      () => pruneDir(dir, [mkEntry('other.js')], { ignore: [join(dir, 'keep.js')] }),
      'outside',
    );
    expect(await pathExists(join(dir, 'keep.js'))).toBe(true);
  });

  test('escaping entry throws and deletes nothing', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'app.js': 'app' });
    await rejectsWith(() => pruneDir(dir, [mkEntry('../evil.js')]));
    expect(await pathExists(join(dir, 'app.js'))).toBe(true);
  });

  test('dir-referencing entry throws and deletes nothing', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'app.js': 'app' });
    await rejectsWith(() => pruneDir(dir, [mkEntry('.')]), 'itself');
    await rejectsWith(() => pruneDir(dir, [mkEntry('./')]), 'itself');
    expect(await pathExists(join(dir, 'app.js'))).toBe(true);
  });

  test('keeps compressed variants and prunes the rest', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, {
      'app-hash.js': 'app',
      'app-hash.js.br': 'br',
      'old.js': 'old',
    });
    await pruneDir(dir, [mkEntry('app-hash.js')], { compressedSuffixes: ['.br', '.gz'] });
    expect(await pathExists(join(dir, 'app-hash.js'))).toBe(true);
    expect(await pathExists(join(dir, 'app-hash.js.br'))).toBe(true);
    expect(await pathExists(join(dir, 'old.js'))).toBe(false);
  });

  test('keeps explicit entry.compressed paths without suffix options', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, {
      'app-hash.js': 'app',
      'app-hash.js.zst': 'zst',
      'old.js': 'old',
    });
    const entry = mkEntry('app-hash.js');
    entry.compressed = { zstd: { path: 'app-hash.js.zst', size: 3, sha256: 'abc' } };
    await pruneDir(dir, [entry]);
    expect(await pathExists(join(dir, 'app-hash.js.zst'))).toBe(true);
    expect(await pathExists(join(dir, 'old.js'))).toBe(false);
  });

  test('removeEmptyDirs removes emptied ancestors, never the root', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'sub/deep/stale.js': 'stale' });
    await pruneDir(dir, [mkEntry('sub/keep.js')], { removeEmptyDirs: true });
    expect(await pathExists(join(dir, 'sub'))).toBe(false);
    expect(await pathExists(dir)).toBe(true);
  });

  test('leaves emptied ancestors by default', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    await writeFiles(dir, { 'sub/deep/stale.js': 'stale' });
    await pruneDir(dir, [mkEntry('sub/keep.js')]);
    expect(await pathExists(join(dir, 'sub'))).toBe(true);
  });
});
