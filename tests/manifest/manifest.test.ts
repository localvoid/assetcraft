import { describe, expect, test } from 'bun:test';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Manifest } from '../../src/manifest.js';
import { importManifests } from '../../src/manifest.js';

describe('importManifests', () => {
  test('returns empty array for no inputs', async () => {
    expect(await importManifests([])).toEqual([]);
  });

  test('imports manifests in order with their paths', async () => {
    await using tmp = await mkdtempDisposable(join(tmpdir(), 'assetcraft-test-'));
    const dir = tmp.path;
    const first: Manifest = [
      {
        type: 'js',
        mime: 'application/javascript',
        immutable: true,
        url: '/assets/a.js',
        path: 'a.js',
        sha256: 'aaa',
        size: 10,
      },
    ];
    const second: Manifest = [
      {
        type: 'css',
        mime: 'text/css',
        url: '/assets/b.css',
        path: 'b.css',
        sha256: 'bbb',
        size: 20,
      },
    ];
    const firstPath = join(dir, 'first.manifest.json');
    const secondPath = join(dir, 'second.manifest.json');
    await writeFile(firstPath, JSON.stringify(first));
    await writeFile(secondPath, JSON.stringify(second));

    const result = await importManifests([firstPath, secondPath]);
    expect(result).toEqual([
      { path: firstPath, manifest: first },
      { path: secondPath, manifest: second },
    ]);
  });
});
