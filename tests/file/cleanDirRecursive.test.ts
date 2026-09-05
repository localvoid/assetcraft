import { describe, expect, test } from 'bun:test';
import { mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanDirRecursive } from '../../src/file.js';
import { makeTempDir, pathExists, withTempDir, writeFiles } from '../helpers.js';

describe('cleanDirRecursive', () => {
  test('removes stale files and keeps exact matches', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'keep.js': 'keep', 'stale.js': 'stale' });
      await cleanDirRecursive(dir, ['keep.js']);
      expect(await pathExists(join(dir, 'keep.js'))).toBe(true);
      expect(await pathExists(join(dir, 'stale.js'))).toBe(false);
    });
  });

  test('nested keeps prune siblings only', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        'a/b/keep.js': 'k',
        'a/b/stale.js': 's',
        'a/other.js': 'o',
        'top-stale.js': 't',
      });
      await cleanDirRecursive(dir, ['a/b/keep.js']);
      expect(await pathExists(join(dir, 'a', 'b', 'keep.js'))).toBe(true);
      expect(await pathExists(join(dir, 'a', 'b', 'stale.js'))).toBe(false);
      expect(await pathExists(join(dir, 'a', 'other.js'))).toBe(false);
      expect(await pathExists(join(dir, 'top-stale.js'))).toBe(false);
    });
  });

  test('trailing slash keeps the whole subtree', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'static/inner/v.js': 'v', 'stale.js': 's' });
      await cleanDirRecursive(dir, ['static/']);
      expect(await pathExists(join(dir, 'static', 'inner', 'v.js'))).toBe(true);
      expect(await pathExists(join(dir, 'stale.js'))).toBe(false);
    });
  });

  test('stale file blocking a nested keep is removed without throwing', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { sub: 'i am a file, not a directory' });
      await cleanDirRecursive(dir, ['sub/keep.js']);
      expect(await pathExists(join(dir, 'sub'))).toBe(false);
    });
  });

  test('duplicate and redundant keeps are idempotent', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'sub/keep.js': 'k', 'sub/stale.js': 's' });
      const keeps = [...Array.from({ length: 200 }, () => 'sub/keep.js'), 'sub', 'sub/'];
      await cleanDirRecursive(dir, keeps);
      // Exact 'sub' keeps the whole subtree, including the stale file.
      expect(await pathExists(join(dir, 'sub', 'keep.js'))).toBe(true);
      expect(await pathExists(join(dir, 'sub', 'stale.js'))).toBe(true);
    });
  });

  test('unmatchable entries never match', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'keep.js': 'keep' });
      await cleanDirRecursive(dir, ['', '.', '/abs.js', '../x.js', 'keep.js']);
      expect(await pathExists(join(dir, 'keep.js'))).toBe(true);
    });
  });

  test('nested keep never follows symlinks outside dir', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    try {
      await writeFiles(outside, { 'victim.txt': 'victim', 'keep.txt': 'keep' });
      await symlink(outside, join(dir, 'link'));
      await writeFiles(dir, { 'top.js': 'top' });
      await cleanDirRecursive(dir, ['link/keep.txt']);
      expect(await pathExists(join(outside, 'victim.txt'))).toBe(true);
      expect(await pathExists(join(dir, 'link'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('exact-kept symlink is preserved without following it', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    try {
      await writeFiles(outside, { 'secret.txt': 'secret' });
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.js'));
      await writeFiles(dir, { 'stale.js': 'x' });
      await cleanDirRecursive(dir, ['link.js']);
      expect(await readlink(join(dir, 'link.js'))).toBe(join(outside, 'secret.txt'));
      expect(await pathExists(join(outside, 'secret.txt'))).toBe(true);
      expect(await pathExists(join(dir, 'stale.js'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('removeEmptyDirs', () => {
    test('leaves emptied ancestors by default', async () => {
      await withTempDir(async (dir) => {
        await writeFiles(dir, { 'sub/deep/stale.js': 'stale' });
        await cleanDirRecursive(dir, ['sub/keep.js']);
        expect(await pathExists(join(dir, 'sub'))).toBe(true);
      });
    });

    test('removes emptied ancestors when enabled, never the root', async () => {
      await withTempDir(async (dir) => {
        await writeFiles(dir, { 'sub/deep/stale.js': 'stale' });
        await cleanDirRecursive(dir, ['sub/keep.js'], { removeEmptyDirs: true });
        expect(await pathExists(join(dir, 'sub'))).toBe(false);
        expect(await pathExists(dir)).toBe(true);
      });
    });

    test('never removes explicitly kept directories', async () => {
      await withTempDir(async (dir) => {
        await writeFiles(dir, { 'sub/deep/stale.js': 'stale' });
        await mkdir(join(dir, 'emptydir'));
        await cleanDirRecursive(dir, ['sub/keep.js', 'emptydir/'], { removeEmptyDirs: true });
        expect(await pathExists(join(dir, 'sub'))).toBe(false);
        expect(await pathExists(join(dir, 'emptydir'))).toBe(true);
      });
    });
  });
});
