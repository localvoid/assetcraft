import type { Manifest, ManifestEntry } from 'assetcraft/manifest';
import { test } from 'bun:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkDeploy,
  checkManifest,
  deriveDeployPath,
  listDeployFiles,
  loadDeployState,
  parseDeployState,
  planDeploy,
  recordHistory,
  resolveDeployPaths,
  readDeployBytes,
  saveDeployState,
} from '../src/deploy.js';
import { urlToString } from '../src/manifest.js';

function jsEntry(
  url: string,
  path: string,
  sha256: string,
  extra?: Partial<ManifestEntry>,
): ManifestEntry {
  return {
    type: 'js',
    mime: 'application/javascript',
    immutable: true,
    url,
    path,
    sha256,
    size: 10,
    ...extra,
  } as ManifestEntry;
}

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'naxe-deploy-'));
  return (async () => {
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('urlToString handles string and object urls', () => {
  equal(urlToString('/s/main.js'), '/s/main.js');
  equal(
    urlToString({ origin: 'https://cdn.example', path: '/s/main.js' }),
    'https://cdn.example/s/main.js',
  );
});

test('deriveDeployPath follows manifest convention', () => {
  equal(deriveDeployPath('./manifest.json'), './manifest.deploy.json');
  equal(deriveDeployPath('./MANIFEST.JSON'), './MANIFEST.deploy.json');
  equal(deriveDeployPath('./manifest'), './manifest.deploy.json');
  equal(deriveDeployPath('./manifest.json', '/ci/deploy.json'), '/ci/deploy.json');
});

test('checkManifest passes on same url+hash, throws on reuse', () => {
  checkManifest([jsEntry('/s/a.js', 'dist/a.js', 'hash1')], [{ url: '/s/a.js', hash: 'hash1' }]);
  throws(
    () =>
      checkManifest(
        [jsEntry('/s/a.js', 'dist/a.js', 'hash2')],
        [{ url: '/s/a.js', hash: 'hash1' }],
      ),
    /Hash collision/,
  );
});

test('checkManifest covers object urls with origin-scoped keys', () => {
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );
  checkManifest([entry], [{ url: 'https://cdn.example/s/a.js', hash: 'hash1' }]);
  // A same-path URL on another origin is a different key — no collision.
  checkManifest([entry], [{ url: 'https://other.example/s/a.js', hash: 'other' }]);
  // Same origin + path with different content collides.
  throws(
    () => checkManifest([entry], [{ url: 'https://cdn.example/s/a.js', hash: 'other' }]),
    /Hash collision/,
  );
});

test('checkManifest ignores mutable entries', () => {
  checkManifest(
    [{ ...jsEntry('/s/a.js', 'dist/a.js', 'hash2'), immutable: false }],
    [{ url: '/s/a.js', hash: 'hash1' }],
  );
});

test('recordHistory returns immutable entries for deploy state', () => {
  const manifest: Manifest = [
    jsEntry('/s/a.js', 'dist/a.js', 'hash1'),
    jsEntry('/s/b.js', 'dist/b.js', 'hash2'),
  ];
  const history = recordHistory(manifest);
  equal(history.length, 2);
  checkManifest(manifest, history);
});

test('recordHistory throws when the new manifest collides with prior history', () => {
  throws(
    () =>
      recordHistory(
        [jsEntry('/s/a.js', 'dist/a.js', 'hash2')],
        [{ url: '/s/a.js', hash: 'hash1' }],
      ),
    /Hash collision/,
  );
});

test('parseDeployState rejects invalid payloads', () => {
  throws(() => parseDeployState('not json'), /Invalid deploy state/);
  throws(() => parseDeployState('[]'), /expected a JSON object/);
  throws(() => parseDeployState('{"history":{}}'), /history must be an array/);
  throws(() => parseDeployState('{"history":[{"url":"/s/a.js"}]}'), /string url\/hash/);
  throws(() => parseDeployState('{"pending":{}}'), /pending must be an array/);
  throws(
    () => parseDeployState('{"pending":[{"path":"a","url":"u","absences":0}]}'),
    /positive integer absences/,
  );
});

test('parseDeployState defaults missing keys to empty arrays', () => {
  deepEqual(parseDeployState('{}'), { history: [], pending: [] });
});

test('loadDeployState returns undefined on missing file, throws on corrupt', async () => {
  await withTempDir(async (dir) => {
    equal(await loadDeployState(join(dir, 'missing.deploy.json')), void 0);
    const bad = join(dir, 'bad.deploy.json');
    writeFileSync(bad, 'corrupt');
    await loadDeployState(bad).then(
      () => {
        throw new Error('expected loadDeployState to throw');
      },
      (err) => {
        ok(err instanceof Error);
      },
    );
  });
});

test('saveDeployState + loadDeployState round-trip', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'manifest.deploy.json');
    const manifest: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
    await saveDeployState(path, {
      history: recordHistory(manifest),
      pending: [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }],
    });
    deepEqual(await loadDeployState(path), {
      history: [{ url: '/s/a.js', hash: 'hash1' }],
      pending: [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }],
    });
  });
});

test('checkDeploy validates manifest and deploy state', async () => {
  await withTempDir(async (dir) => {
    const manifestPath = join(dir, 'manifest.json');
    const deployPath = join(dir, 'manifest.deploy.json');
    writeFileSync(manifestPath, JSON.stringify([jsEntry('/s/a.js', 'dist/a.js', 'hash1')]));
    writeFileSync(
      deployPath,
      JSON.stringify({ history: [{ url: '/s/a.js', hash: 'hash1' }], pending: [] }),
    );
    const { manifest, state } = await checkDeploy(manifestPath, deployPath);
    equal(manifest.length, 1);
    deepEqual(state, { history: [{ url: '/s/a.js', hash: 'hash1' }], pending: [] });

    writeFileSync(
      deployPath,
      JSON.stringify({ history: [{ url: '/s/a.js', hash: 'other' }], pending: [] }),
    );
    await checkDeploy(manifestPath, deployPath).then(
      () => {
        throw new Error('expected checkDeploy to throw');
      },
      (err) => {
        ok(/Hash collision/.test((err as Error).message));
      },
    );

    writeFileSync(manifestPath, 'not a manifest');
    await checkDeploy(manifestPath, deployPath).then(
      () => {
        throw new Error('expected checkDeploy to throw');
      },
      (err) => {
        ok(/Invalid manifest/.test((err as Error).message));
      },
    );
  });
});

test('listDeployFiles expands identity + variant rows', () => {
  const entry = jsEntry('/s/a.js', 'dist/a.js', 'hash1', {
    headers: { 'Cache-Control': 'immutable' },
    compressed: {
      br: { path: 'dist/a.js.br', size: 5, sha256: 'brhash' },
      gzip: { path: 'dist/a.js.gz', size: 6, sha256: 'gzhash' },
    },
  });
  const files = listDeployFiles([entry]);
  equal(files.length, 3);
  equal(files[0]?.url, '/s/a.js');
  equal(files[0]?.encoding, void 0);
  equal(files[0]?.mime, 'application/javascript');
  equal(files[0]?.immutable, true);
  deepEqual(files[0]?.headers, { 'Cache-Control': 'immutable' });
  ok(files[0]?.entry === entry);
  equal(files[1]?.url, '/s/a.js.br');
  equal(files[1]?.path, 'dist/a.js.br');
  equal(files[1]?.encoding, 'br');
  equal(files[2]?.url, '/s/a.js.gz');
  equal(files[2]?.encoding, 'gzip');
});

test('listDeployFiles skips object urls unless includeExternal', () => {
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );
  equal(listDeployFiles([entry]).length, 0);
  const included = listDeployFiles([entry], { includeExternal: true });
  equal(included.length, 1);
  equal(included[0]?.url, 'https://cdn.example/s/a.js');
});

test('resolveDeployPaths absolutizes against manifest dir', () => {
  const files = listDeployFiles([jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const resolved = resolveDeployPaths(files, '/app');
  equal(resolved[0]?.path, '/app/dist/a.js');
});

test('readDeployBytes reads resolved file bytes', async () => {
  await withTempDir(async (dir) => {
    const rel = join('dist', 'a.js');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, rel), 'hello');
    const [file] = resolveDeployPaths(listDeployFiles([jsEntry('/s/a.js', rel, 'hash1')]), dir);
    ok(file !== void 0);
    equal(new TextDecoder().decode(await readDeployBytes(file)), 'hello');
    equal(dirname(file.path), join(dir, 'dist'));
  });
});

test('planDeploy uploads everything on first deploy', () => {
  const next: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  const plan = planDeploy(void 0, next);
  equal(plan.add.length, 1);
  equal(plan.remove.length, 0);
  equal(plan.pendingRemove.length, 0);
  equal(plan.unchanged, 0);
});

test('planDeploy uploads added + hash-changed, keeps metadata-only', () => {
  const prev: Manifest = [
    jsEntry('/s/a.js', 'dist/a.js', 'hash1'),
    jsEntry('/s/b.js', 'dist/b.js', 'hashB'),
  ];
  const next: Manifest = [
    { ...jsEntry('/s/a.js', 'dist/a.js', 'hash2') },
    { ...jsEntry('/s/b.js', 'dist/b.js', 'hashB'), headers: { 'x-new': '1' } },
    jsEntry('/s/c.js', 'dist/c.js', 'hashC'),
  ];
  const plan = planDeploy(prev, next);
  deepEqual(plan.add.map((f) => f.url).sort(), ['/s/a.js', '/s/c.js']);
  equal(plan.unchanged, 0);
});

test('planDeploy holds removals for keepDeploys then deletes', () => {
  const oldEntry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  const prev: Manifest = [oldEntry, jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  const next: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];

  const first = planDeploy(prev, next);
  equal(first.remove.length, 0);
  deepEqual(first.pendingRemove, [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }]);

  const second = planDeploy(prev, next, first.pendingRemove);
  deepEqual(
    second.remove.map((f) => f.url),
    ['/s/old.js'],
  );
  equal(second.pendingRemove.length, 0);
});

test('planDeploy with keepDeploys: 1 deletes immediately, : 3 waits', () => {
  const prev: Manifest = [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')];
  const next: Manifest = [];
  equal(planDeploy(prev, next, void 0, { keepDeploys: 1 }).remove.length, 1);
  const held = planDeploy(prev, next, void 0, { keepDeploys: 3 });
  equal(held.remove.length, 0);
  deepEqual(held.pendingRemove, [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }]);
  const again = planDeploy(prev, next, held.pendingRemove, { keepDeploys: 3 });
  equal(again.remove.length, 0);
  deepEqual(again.pendingRemove, [{ path: 'dist/old.js', url: '/s/old.js', absences: 2 }]);
  equal(planDeploy(prev, next, again.pendingRemove, { keepDeploys: 3 }).remove.length, 1);
});

test('planDeploy clears pending when the path reappears', () => {
  const entry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  const prev: Manifest = [entry];
  const pending = [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }];
  const plan = planDeploy(prev, [entry], pending);
  equal(plan.pendingRemove.length, 0);
  equal(plan.remove.length, 0);
  equal(plan.unchanged, 1);
});

test('planDeploy rejects invalid keepDeploys', () => {
  const manifest: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  throws(() => planDeploy(manifest, manifest, void 0, { keepDeploys: 0 }), /keepDeploys/);
  throws(() => planDeploy(manifest, manifest, void 0, { keepDeploys: 1.5 }), /keepDeploys/);
});

test('planDeploy removeNow includes variant rows with the parent', () => {
  const oldEntry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld', {
    compressed: { br: { path: 'dist/old.js.br', size: 4, sha256: 'brhash' } },
  });
  const plan = planDeploy([oldEntry], [], void 0, { keepDeploys: 1 });
  deepEqual(plan.remove.map((f) => f.url).sort(), ['/s/old.js', '/s/old.js.br']);
});

test('planDeploy skips external removals unless includeExternal', () => {
  const external = jsEntry(
    { origin: 'https://cdn.example', path: '/s/x.js' } as never,
    'dist/x.js',
    'hashX',
  );
  const plan = planDeploy([external], [], void 0, { keepDeploys: 1 });
  equal(plan.remove.length, 0);
  const included = planDeploy([external], [], void 0, { keepDeploys: 1, includeExternal: true });
  deepEqual(
    included.remove.map((f) => f.url),
    ['https://cdn.example/s/x.js'],
  );
});
