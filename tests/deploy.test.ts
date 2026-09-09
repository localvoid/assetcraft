import type { Manifest, ManifestEntry } from 'assetcraft/manifest';
import { test } from 'bun:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtempDisposableSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Deploy } from '../src/deploy.js';
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

function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest));
}

/** Open a single object manifest with a temp-dir sidecar. */
function openSingle(
  dir: string,
  manifest: Manifest,
  options?: { keepDeploys?: number; includeExternal?: boolean },
): Promise<Deploy> {
  const manifestPath = join(dir, 'manifest.json');
  writeManifest(manifestPath, manifest);
  return Deploy.open({
    manifests: [manifestPath],
    deployPath: join(dir, 'manifest.deploy.json'),
    ...options,
  });
}

test('urlToString handles string and object urls', () => {
  equal(urlToString('/s/main.js'), '/s/main.js');
  equal(
    urlToString({ origin: 'https://cdn.example', path: '/s/main.js' }),
    'https://cdn.example/s/main.js',
  );
});

test('open rejects empty or duplicate manifests', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const deployPath = join(dir.path, 'manifest.deploy.json');
  await Deploy.open({ manifests: [], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/at least one manifest path/.test((err as Error).message));
    },
  );
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, []);
  await Deploy.open({ manifests: [manifestPath, manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Duplicate manifest/.test((err as Error).message));
    },
  );
});

test('open combines multiple manifests in order', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html-manifest.json');
  const jsPath = join(dir.path, 'js-manifest.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1'), jsEntry('/s/b.js', 'b.js', 'hash2')]);
  const deploy = await Deploy.open({
    manifests: [htmlPath, jsPath],
    deployPath: join(dir.path, 'manifest.deploy.json'),
  });
  deepEqual(deploy.manifests, [htmlPath, jsPath]);
  equal(deploy.manifest.length, 3);
  deepEqual(
    deploy.files().map((f) => f.url),
    ['/index.html', '/s/a.js', '/s/b.js'],
  );
});

test('resolve uses each manifest directory', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html', 'manifest.json');
  const jsPath = join(dir.path, 'js', 'manifest.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  const deploy = await Deploy.open({
    manifests: [htmlPath, jsPath],
    deployPath: join(dir.path, 'manifest.deploy.json'),
  });
  deepEqual(
    deploy.resolve().map((f) => f.path),
    [join(dir.path, 'html', 'index.html'), join(dir.path, 'js', 'a.js')],
  );
});

test('same relative path in different manifests stays distinct', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const firstPath = join(dir.path, 'first', 'manifest.json');
  const secondPath = join(dir.path, 'second', 'manifest.json');
  writeManifest(firstPath, [jsEntry('/one.js', 'app.js', 'hash1')]);
  writeManifest(secondPath, [jsEntry('/two.js', 'app.js', 'hash2')]);
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const first = await Deploy.open({ manifests: [firstPath, secondPath], deployPath });
  equal(first.plan().add.length, 2);
  await first.commit();
  const second = await Deploy.open({ manifests: [firstPath, secondPath], deployPath });
  const plan = second.plan();
  equal(plan.add.length, 0);
  equal(plan.unchanged, 2);
  deepEqual(
    second
      .resolve()
      .map((f) => f.path)
      .sort(),
    [join(dir.path, 'first', 'app.js'), join(dir.path, 'second', 'app.js')],
  );
});

test('open passes on same url+hash, throws on reuse', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  await (await openSingle(dir.path, manifest)).commit();
  // Same url+hash reopens cleanly.
  await openSingle(dir.path, manifest);
  // Same url with different content collides.
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash2')]);
  await Deploy.open({ manifests: [manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );
});

test('open validates against persisted history', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  writeFileSync(
    deployPath,
    JSON.stringify({ history: [{ url: '/s/a.js', hash: 'hash1' }], pending: [] }),
  );
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  equal(deploy.manifest.length, 1);

  writeFileSync(
    deployPath,
    JSON.stringify({ history: [{ url: '/s/a.js', hash: 'other' }], pending: [] }),
  );
  await Deploy.open({ manifests: [manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );

  writeManifest(manifestPath, 'not a manifest' as never);
  await Deploy.open({ manifests: [manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Invalid manifest/.test((err as Error).message));
    },
  );
});

test('open throws on missing manifest file', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  await Deploy.open({
    manifests: [join(dir.path, 'missing.json')],
    deployPath: join(dir.path, 'manifest.deploy.json'),
  }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Invalid manifest.*file not found/.test((err as Error).message));
    },
  );
});

test('open covers object urls with origin-scoped keys', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );

  const deployPath = join(dir.path, 'manifest.deploy.json');
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, [entry]);
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [{ url: 'https://cdn.example/s/a.js', hash: 'hash1' }],
      pending: [],
    }),
  );
  await Deploy.open({ manifests: [manifestPath], deployPath });
  // A same-path URL on another origin is a different key — no collision.
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [{ url: 'https://other.example/s/a.js', hash: 'other' }],
      pending: [],
    }),
  );
  await Deploy.open({ manifests: [manifestPath], deployPath });
  // Same origin + path with different content collides.
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [{ url: 'https://cdn.example/s/a.js', hash: 'other' }],
      pending: [],
    }),
  );
  await Deploy.open({ manifests: [manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );
});

test('open ignores mutable entries', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeFileSync(
    deployPath,
    JSON.stringify({ history: [{ url: '/s/a.js', hash: 'hash1' }], pending: [] }),
  );
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, [{ ...jsEntry('/s/a.js', 'dist/a.js', 'hash2'), immutable: false }]);
  await Deploy.open({ manifests: [manifestPath], deployPath });
});

test('open treats missing state as first deploy, throws on corrupt', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  equal(deploy.plan().add.length, 1);

  writeFileSync(deployPath, 'corrupt');
  await Deploy.open({ manifests: [manifestPath], deployPath }).then(
    () => {
      throw new Error('expected open to throw');
    },
    (err) => {
      ok(/Invalid deploy state/.test((err as Error).message));
    },
  );
});

test('open rejects invalid deploy state shapes', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, []);
  const cases: Array<[string, RegExp]> = [
    ['[]', /expected a JSON object/],
    ['{"history":{}}', /history must be an array/],
    ['{"history":[{"url":"/s/a.js"}]}', /string url\/hash/],
    ['{"pending":{}}', /pending must be an array/],
    ['{"pending":[{"path":"a","url":"u","absences":0}]}', /positive integer absences/],
    ['{"pending":[{"path":"a","url":"u","absences":1,"source":7}]}', /positive integer absences/],
    ['{"prevManifests":{}}', /prevManifests must be an array/],
    ['{"prevManifests":[{}]}', /string source\/dir/],
    [
      '{"prevManifests":[{"source":"m.json","dir":".","entries":[{"type":"nope"}]}]}',
      /prev manifest 'm\.json' is invalid/,
    ],
  ];
  for (const [body, re] of cases) {
    writeFileSync(deployPath, body);
    await Deploy.open({ manifests: [manifestPath], deployPath }).then(
      () => {
        throw new Error(`expected open to throw for ${body}`);
      },
      (err) => {
        ok(re.test((err as Error).message), `${body}: ${(err as Error).message}`);
      },
    );
  }
  writeFileSync(deployPath, '{}');
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  equal(deploy.plan().add.length, 0);
});

test('state without prevManifests uploads everything, keeps history', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const manifest: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  writeManifest(manifestPath, manifest);
  // Legacy shape: no prevManifests, pending without source.
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [{ url: '/s/a.js', hash: 'hash1' }],
      pending: [{ path: 'dist/old.js', url: '/s/old.js', absences: 1 }],
    }),
  );
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  const plan = deploy.plan();
  equal(plan.add.length, 1);
  equal(plan.remove.length, 0);
  // Unattributed pending can't match a snapshot: flushed on commit.
  await deploy.commit();
  const reopened = await Deploy.open({ manifests: [manifestPath], deployPath });
  equal(reopened.plan().pendingRemove.length, 0);
  equal(reopened.plan().unchanged, 1);
});

test('commit stores prevManifests snapshots', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html', 'manifest.json');
  const jsPath = join(dir.path, 'js', 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  await (await Deploy.open({ manifests: [htmlPath, jsPath], deployPath })).commit();
  const state = JSON.parse(readFileSync(deployPath, 'utf8')) as {
    prevManifests: Array<{ source: string; dir: string; entries: Manifest }>;
  };
  deepEqual(
    state.prevManifests.map((r) => r.source),
    [htmlPath, jsPath],
  );
  deepEqual(
    state.prevManifests.map((r) => r.dir),
    [join(dir.path, 'html'), join(dir.path, 'js')],
  );
  equal(state.prevManifests[0]?.entries.length, 1);
  equal(state.prevManifests[1]?.entries.length, 1);
});

test('second cycle needs no prev input', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  const plan = deploy.plan();
  equal(plan.add.length, 0);
  equal(plan.remove.length, 0);
  equal(plan.unchanged, 1);
});

test('plan uploads added + hash-changed, keeps metadata-only', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [
    jsEntry('/s/a.js', 'dist/a.js', 'hash1'),
    jsEntry('/s/b.js', 'dist/b.js', 'hashB'),
  ]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();
  // Content change ships under a new hashed URL (same-URL reuse is forbidden);
  // headers-only edits upload nothing.
  writeManifest(manifestPath, [
    { ...jsEntry('/s/a-h2.js', 'dist/a.js', 'hash2') },
    { ...jsEntry('/s/b.js', 'dist/b.js', 'hashB'), headers: { 'x-new': '1' } },
    jsEntry('/s/c.js', 'dist/c.js', 'hashC'),
  ]);
  const plan = (await Deploy.open({ manifests: [manifestPath], deployPath })).plan();
  deepEqual(plan.add.map((f) => f.url).sort(), ['/s/a-h2.js', '/s/c.js']);
  equal(plan.unchanged, 0);
});

test('plan holds removals for keepDeploys then deletes', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const oldEntry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  writeManifest(manifestPath, [oldEntry, jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();

  const next: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  writeManifest(manifestPath, next);
  const first = await Deploy.open({ manifests: [manifestPath], deployPath });
  equal(first.plan().remove.length, 0);
  deepEqual(first.plan().pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', absences: 1 },
  ]);
  await first.commit();

  const second = await Deploy.open({ manifests: [manifestPath], deployPath });
  deepEqual(
    second.plan().remove.map((f) => f.url),
    ['/s/old.js'],
  );
  equal(second.plan().pendingRemove.length, 0);
});

test('plan with keepDeploys: 1 deletes immediately, : 3 waits', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();
  writeManifest(manifestPath, []);

  const immediate = await Deploy.open({
    manifests: [manifestPath],
    deployPath,
    keepDeploys: 1,
  });
  equal(immediate.plan().remove.length, 1);

  const held = await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys: 3 });
  equal(held.plan().remove.length, 0);
  deepEqual(held.plan().pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', absences: 1 },
  ]);
  await held.commit();
  const again = await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys: 3 });
  equal(again.plan().remove.length, 0);
  deepEqual(again.plan().pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', absences: 2 },
  ]);
  await again.commit();
  const last = await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys: 3 });
  equal(last.plan().remove.length, 1);
});

test('added manifest source uploads everything, removed source deletes under grace', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const jsPath = join(dir.path, 'js', 'manifest.json');
  const cssPath = join(dir.path, 'css', 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  await (await Deploy.open({ manifests: [jsPath], deployPath, keepDeploys: 1 })).commit();

  // New css source appears: all its entries upload, js entry unchanged.
  writeManifest(cssPath, [jsEntry('/s/b.css', 'b.css', 'hashB')]);
  const added = await Deploy.open({
    manifests: [jsPath, cssPath],
    deployPath,
    keepDeploys: 1,
  });
  const addedPlan = added.plan();
  deepEqual(
    addedPlan.add.map((f) => f.url),
    ['/s/b.css'],
  );
  equal(addedPlan.unchanged, 1);
  await added.commit();

  // js source disappears: held for one grace cycle, then removed with its own dir.
  const removed = await Deploy.open({ manifests: [cssPath], deployPath });
  equal(removed.plan().remove.length, 0);
  deepEqual(removed.plan().pendingRemove, [
    { source: jsPath, path: 'a.js', url: '/s/a.js', absences: 1 },
  ]);
  await removed.commit();
  const gone = await Deploy.open({ manifests: [cssPath], deployPath });
  const removedPlan = gone.plan();
  deepEqual(
    removedPlan.remove.map((f) => f.url),
    ['/s/a.js'],
  );
  deepEqual(
    gone.resolve(removedPlan.remove).map((f) => f.path),
    [join(dir.path, 'js', 'a.js')],
  );
  equal(removedPlan.unchanged, 1);
});

test('plan clears pending when the path reappears', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const entry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  writeManifest(manifestPath, [entry]);
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [],
      pending: [{ source: manifestPath, path: 'dist/old.js', url: '/s/old.js', absences: 1 }],
      prevManifests: [{ source: manifestPath, dir: dir, entries: [entry] }],
    }),
  );
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  const plan = deploy.plan();
  equal(plan.pendingRemove.length, 0);
  equal(plan.remove.length, 0);
  equal(plan.unchanged, 1);
});

test('open rejects invalid keepDeploys', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  for (const keepDeploys of [0, 1.5]) {
    let thrown = false;
    try {
      await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys });
    } catch (err) {
      thrown = true;
      ok(/keepDeploys/.test((err as Error).message));
    }
    ok(thrown, `expected open to throw for keepDeploys ${keepDeploys}`);
  }
});

test('commit updates in-memory state for subsequent plans', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const next: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  const oldEntry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  writeManifest(manifestPath, next);
  writeFileSync(
    deployPath,
    JSON.stringify({
      history: [],
      pending: [{ source: manifestPath, path: 'dist/old.js', url: '/s/old.js', absences: 1 }],
      prevManifests: [{ source: manifestPath, dir, entries: [...next, oldEntry] }],
    }),
  );
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath });
  // Pending absence graduates to a removal…
  deepEqual(
    deploy.plan().remove.map((f) => f.url),
    ['/s/old.js'],
  );
  await deploy.commit();
  // …and the same instance sees the commit: nothing left to remove.
  const again = deploy.plan();
  equal(again.remove.length, 0);
  equal(again.pendingRemove.length, 0);
  equal(again.unchanged, 1);
});

test('files expands identity + variant rows', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry('/s/a.js', 'dist/a.js', 'hash1', {
    headers: { 'Cache-Control': 'immutable' },
    compressed: {
      br: { path: 'dist/a.js.br', size: 5, sha256: 'brhash' },
      gzip: { path: 'dist/a.js.gz', size: 6, sha256: 'gzhash' },
    },
  });
  const deploy = await openSingle(dir.path, [entry]);
  const files = deploy.files();
  equal(files.length, 3);
  equal(files[0]?.url, '/s/a.js');
  equal(files[0]?.encoding, undefined);
  equal(files[0]?.mime, 'application/javascript');
  equal(files[0]?.immutable, true);
  deepEqual(files[0]?.headers, { 'Cache-Control': 'immutable' });
  ok(files[0]?.entry === deploy.manifest[0]);
  equal(files[1]?.url, '/s/a.js.br');
  equal(files[1]?.path, 'dist/a.js.br');
  equal(files[1]?.encoding, 'br');
  equal(files[2]?.url, '/s/a.js.gz');
  equal(files[2]?.encoding, 'gzip');
});

test('files skips object urls unless includeExternal', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );
  equal((await openSingle(dir.path, [entry])).files().length, 0);
  const included = await openSingle(dir.path, [entry], { includeExternal: true });
  equal(included.files().length, 1);
  equal(included.files()[0]?.url, 'https://cdn.example/s/a.js');
});

test('resolve throws on foreign entries', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const deploy = await openSingle(dir.path, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const foreign = jsEntry('/s/x.js', 'dist/x.js', 'hashX');
  let thrown = false;
  try {
    deploy.resolve([
      {
        url: '/s/x.js',
        path: 'dist/x.js',
        size: 1,
        sha256: 'hashX',
        mime: 'application/javascript',
        immutable: true,
        headers: undefined,
        encoding: undefined,
        entry: foreign,
      },
    ]);
  } catch (err) {
    thrown = true;
    ok(/Unknown deploy file/.test((err as Error).message));
  }
  ok(thrown, 'expected resolve to throw');
});

test('read reads resolved file bytes', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'js', 'manifest.json');
  const rel = join('dist', 'a.js');
  mkdirSync(join(dir.path, 'js', 'dist'), { recursive: true });
  writeFileSync(join(dir.path, 'js', rel), 'hello');
  writeManifest(manifestPath, [jsEntry('/s/a.js', rel, 'hash1')]);
  const deploy = await Deploy.open({
    manifests: [manifestPath],
    deployPath: join(dir.path, 'manifest.deploy.json'),
  });
  const [file] = deploy.resolve();
  ok(file !== undefined);
  equal(new TextDecoder().decode(await deploy.read(file)), 'hello');
  equal(dirname(file.path), join(dir.path, 'js', 'dist'));
});

test('plan uploads everything on first deploy', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const deploy = await openSingle(dir.path, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const plan = deploy.plan();
  equal(plan.add.length, 1);
  equal(plan.remove.length, 0);
  equal(plan.pendingRemove.length, 0);
  equal(plan.unchanged, 0);
});

test('plan remove includes variant rows with the parent', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [
    jsEntry('/s/old.js', 'dist/old.js', 'hashOld', {
      compressed: { br: { path: 'dist/old.js.br', size: 4, sha256: 'brhash' } },
    }),
  ]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();
  writeManifest(manifestPath, []);
  const deploy = await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys: 1 });
  deepEqual(
    deploy
      .plan()
      .remove.map((f) => f.url)
      .sort(),
    ['/s/old.js', '/s/old.js.br'],
  );
});

test('plan skips external removals unless includeExternal', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const deployPath = join(dir.path, 'manifest.deploy.json');
  const external = jsEntry(
    { origin: 'https://cdn.example', path: '/s/x.js' } as never,
    'dist/x.js',
    'hashX',
  );
  writeManifest(manifestPath, [external]);
  await (await Deploy.open({ manifests: [manifestPath], deployPath })).commit();
  writeManifest(manifestPath, []);
  const plan = (
    await Deploy.open({ manifests: [manifestPath], deployPath, keepDeploys: 1 })
  ).plan();
  equal(plan.remove.length, 0);
  const included = (
    await Deploy.open({
      manifests: [manifestPath],
      deployPath,
      keepDeploys: 1,
      includeExternal: true,
    })
  ).plan();
  deepEqual(
    included.remove.map((f) => f.url),
    ['https://cdn.example/s/x.js'],
  );
});

test('commit writes to an override path', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'naxe-deploy-'));
  const deploy = await openSingle(dir.path, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const target = join(dir.path, 'elsewhere', 'deploy.json');
  await deploy.commit(target);
  const reopened = await Deploy.open({
    manifests: [join(dir.path, 'manifest.json')],
    deployPath: target,
  });
  equal(reopened.plan().unchanged, 1);
});
