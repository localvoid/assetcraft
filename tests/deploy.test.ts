import type { Manifest, ManifestEntry } from 'assetcraft/manifest';
import { test } from 'bun:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PrepareDeployOptions } from '../src/deploy.js';
import { prepareDeploy } from '../src/deploy.js';
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

/** Run a single-manifest deploy cycle with a temp-dir sidecar. */
function prepareSingle(
  dir: string,
  manifest: Manifest,
  options?: Partial<PrepareDeployOptions> & { now?: number },
): Promise<Awaited<ReturnType<typeof prepareDeploy>>> {
  const manifestPath = join(dir, 'manifest.json');
  writeManifest(manifestPath, manifest);
  return prepareDeploy({
    manifests: [manifestPath],
    path: join(dir, 'manifest.deploy.json'),
    now: 1000,
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

test('prepareDeploy rejects empty or duplicate manifests', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const path = join(dir.path, 'manifest.deploy.json');
  await prepareDeploy({ manifests: [], path }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/at least one manifest path/.test((err as Error).message));
    },
  );
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, []);
  await prepareDeploy({ manifests: [manifestPath, manifestPath], path }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Duplicate manifest/.test((err as Error).message));
    },
  );
});

test('prepareDeploy combines multiple manifests in order', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html-manifest.json');
  const jsPath = join(dir.path, 'js-manifest.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1'), jsEntry('/s/b.js', 'b.js', 'hash2')]);
  const result = await prepareDeploy({
    manifests: [htmlPath, jsPath],
    path: join(dir.path, 'manifest.deploy.json'),
    now: 1000,
  });
  deepEqual(
    result.snapshots.map((s) => s.source),
    [htmlPath, jsPath],
  );
  equal(result.embed.length, 3);
  deepEqual(
    result.embed.map((f) => f.url),
    ['/index.html', '/s/a.js', '/s/b.js'],
  );
});

test('embed resolves each manifest directory', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html', 'manifest.json');
  const jsPath = join(dir.path, 'js', 'manifest.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  const result = await prepareDeploy({
    manifests: [htmlPath, jsPath],
    path: join(dir.path, 'manifest.deploy.json'),
    now: 1000,
  });
  deepEqual(
    result.embed.map((f) => f.path),
    [join(dir.path, 'html', 'index.html'), join(dir.path, 'js', 'a.js')],
  );
});

test('same relative path in different manifests stays distinct', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const firstPath = join(dir.path, 'first', 'manifest.json');
  const secondPath = join(dir.path, 'second', 'manifest.json');
  writeManifest(firstPath, [jsEntry('/one.js', 'app.js', 'hash1')]);
  writeManifest(secondPath, [jsEntry('/two.js', 'app.js', 'hash2')]);
  const path = join(dir.path, 'manifest.deploy.json');
  const first = await prepareDeploy({ manifests: [firstPath, secondPath], path, now: 1000 });
  equal(first.plan.add.length, 2);
  const second = await prepareDeploy({ manifests: [firstPath, secondPath], path, now: 2000 });
  const plan = second.plan;
  equal(plan.add.length, 0);
  equal(plan.unchanged, 2);
  deepEqual(second.embed.map((f) => f.path).sort(), [
    join(dir.path, 'first', 'app.js'),
    join(dir.path, 'second', 'app.js'),
  ]);
  // Unchanged content keeps its original timestamp.
  for (const file of second.embed) {
    equal(file.deployedAt, 1000);
  }
});

test('same url+hash passes, reuse with different content throws', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  await prepareSingle(dir.path, manifest, { now: 1000 });
  // Same url+hash reopens cleanly.
  await prepareSingle(dir.path, manifest, { now: 2000 });
  // Same url with different content collides.
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash2')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 3000 }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );
});

test('history enforced against persisted state', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  const manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  writeManifest(manifestPath, manifest);
  const first = await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  equal(first.embed.length, 1);

  // Tamper the history hash: next cycle must throw.
  const state = JSON.parse(readFileSync(path, 'utf8')) as { history: { sha256: string }[] };
  state.history[0]!.sha256 = 'other';
  writeFileSync(path, JSON.stringify(state));
  await prepareDeploy({ manifests: [manifestPath], path, now: 2000 }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );

  writeManifest(manifestPath, 'not a manifest' as never);
  await prepareDeploy({ manifests: [manifestPath], path, now: 2000 }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Invalid manifest/.test((err as Error).message));
    },
  );
});

test('prepareDeploy throws on missing manifest file', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  await prepareDeploy({
    manifests: [join(dir.path, 'missing.json')],
    path: join(dir.path, 'manifest.deploy.json'),
    now: 1000,
  }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Invalid manifest.*file not found/.test((err as Error).message));
    },
  );
});

test('object urls use origin-scoped history keys', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );
  const manifestPath = join(dir.path, 'manifest.json');
  writeManifest(manifestPath, [entry]);

  // Default: external entries excluded from plan/embed but history-tracked.
  const skipped = await prepareSingle(dir.path, [entry], { now: 1000 });
  equal(skipped.plan.add.length, 0);
  equal(skipped.embed.length, 0);

  // Same-path URL on another origin is a different key — no collision.
  const path = join(dir.path, 'manifest.deploy.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    history: { url: string; sha256: string }[];
  };
  const historyUrl = state.history[0]!.url;
  equal(historyUrl, 'https://cdn.example/s/a.js');
  state.history[0]!.url = 'https://other.example/s/a.js';
  writeFileSync(path, JSON.stringify(state));
  await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });

  // Same origin + path with different content collides.
  const state2 = JSON.parse(readFileSync(path, 'utf8')) as {
    history: { url: string; sha256: string }[];
  };
  const tracked = state2.history.find((h) => h.url === 'https://cdn.example/s/a.js');
  ok(tracked !== undefined);
  tracked.sha256 = 'other';
  writeFileSync(path, JSON.stringify(state2));
  await prepareDeploy({ manifests: [manifestPath], path, now: 3000 }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Hash collision/.test((err as Error).message));
    },
  );
});

test('mutable entries ignored by history', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const first = await prepareSingle(dir.path, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')], {
    now: 1000,
  });
  equal(first.plan.add.length, 1);
  // Same URL, different content, mutable: no collision.
  const second = await prepareSingle(
    dir.path,
    [{ ...jsEntry('/s/a.js', 'dist/a.js', 'hash2'), immutable: false }],
    { now: 2000 },
  );
  equal(second.plan.add.length, 1);
});

test('missing state is a first deploy, corrupt state throws', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  const first = await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  equal(first.plan.add.length, 1);

  writeFileSync(path, 'corrupt');
  await prepareDeploy({ manifests: [manifestPath], path, now: 2000 }).then(
    () => {
      throw new Error('expected prepareDeploy to throw');
    },
    (err) => {
      ok(/Invalid deploy state/.test((err as Error).message));
    },
  );
});

test('prepareDeploy rejects invalid deploy state shapes', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, []);
  const entry = jsEntry('/s/a.js', 'dist/a.js', 'hash1');
  const valid = {
    history: [],
    pending: [],
    prevManifests: [{ source: manifestPath, dir: dir.path, entries: [entry] }],
    deployedAt: { [manifestPath]: { 'dist/a.js': 1000 } },
  };
  const cases: Array<[string, RegExp, (v: typeof valid) => unknown]> = [
    ['missing history', /history must be an array/, (v) => ({ ...v, history: {} })],
    ['bad history entry', /string url\/hash/, (v) => ({ ...v, history: [{ url: '/s/a.js' }] })],
    ['missing pending', /pending must be an array/, (v) => ({ ...v, pending: {} })],
    [
      'bad pending item',
      /string source\/path\/url/,
      (v) => ({ ...v, pending: [{ path: 'a', url: 'u', missedDeploys: 0 }] }),
    ],
    [
      'pending without source',
      /string source\/path\/url/,
      (v) => ({ ...v, pending: [{ path: 'a', url: 'u', missedDeploys: 1 }] }),
    ],
    ['missing snapshots', /prevManifests must be an array/, (v) => ({ ...v, prevManifests: {} })],
    ['bad snapshot', /string source\/dir/, (v) => ({ ...v, prevManifests: [{}] })],
    [
      'invalid snapshot entry',
      /prev manifest 'm\.json' is invalid/,
      (v) => ({
        ...v,
        prevManifests: [{ source: 'm.json', dir: '.', entries: [{ type: 'nope' }] }],
      }),
    ],
    ['missing deployedAt', /deployedAt must be an object/, (v) => ({ ...v, deployedAt: [] })],
    [
      'bad deployedAt value',
      /unix seconds/,
      (v) => ({ ...v, deployedAt: { [manifestPath]: { 'dist/a.js': 'now' } } }),
    ],
  ];
  for (const [label, re, mutate] of cases) {
    writeFileSync(path, JSON.stringify(mutate(valid)));
    await prepareDeploy({ manifests: [manifestPath], path, now: 2000 }).then(
      () => {
        throw new Error(`expected prepareDeploy to throw for ${label}`);
      },
      (err) => {
        ok(re.test((err as Error).message), `${label}: ${(err as Error).message}`);
      },
    );
  }
});

test('result snapshots match persisted state', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const htmlPath = join(dir.path, 'html', 'manifest.json');
  const jsPath = join(dir.path, 'js', 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(htmlPath, [jsEntry('/index.html', 'index.html', 'hashH')]);
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  const result = await prepareDeploy({ manifests: [htmlPath, jsPath], path, now: 1000 });
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    prevManifests: Array<{ source: string; dir: string; entries: Manifest }>;
    deployedAt: Record<string, Record<string, number>>;
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
  deepEqual(result.snapshots, state.prevManifests);
  deepEqual(state.deployedAt, { [htmlPath]: { 'index.html': 1000 }, [jsPath]: { 'a.js': 1000 } });
  equal(result.deployedAt, 1000);
});

test('second cycle uploads nothing without reread', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  const deploy = await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });
  equal(deploy.plan.add.length, 0);
  equal(deploy.plan.remove.length, 0);
  equal(deploy.plan.unchanged, 1);
  equal(deploy.embed.length, 1);
  // Content unchanged: original deploy timestamp carried over.
  equal(deploy.embed[0]?.deployedAt, 1000);
});

test('plan uploads added + hash-changed, keeps metadata-only', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [
    jsEntry('/s/a.js', 'dist/a.js', 'hash1'),
    jsEntry('/s/b.js', 'dist/b.js', 'hashB'),
  ]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  // Content change ships under a new hashed URL (same-URL reuse is forbidden);
  // headers-only edits upload nothing.
  writeManifest(manifestPath, [
    { ...jsEntry('/s/a-h2.js', 'dist/a.js', 'hash2') },
    { ...jsEntry('/s/b.js', 'dist/b.js', 'hashB'), headers: { 'x-new': '1' } },
    jsEntry('/s/c.js', 'dist/c.js', 'hashC'),
  ]);
  const result = await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });
  deepEqual(result.plan.add.map((f) => f.url).sort(), ['/s/a-h2.js', '/s/c.js']);
  equal(result.plan.unchanged, 0);
  for (const file of result.plan.add) {
    equal(file.deployedAt, 2000);
  }
});

test('plan holds removals for maxMissedDeploys then deletes', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  const oldEntry = jsEntry('/s/old.js', 'dist/old.js', 'hashOld');
  writeManifest(manifestPath, [oldEntry, jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });

  const next: Manifest = [jsEntry('/s/a.js', 'dist/a.js', 'hash1')];
  writeManifest(manifestPath, next);
  const first = await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });
  equal(first.plan.remove.length, 0);
  deepEqual(first.plan.pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', missedDeploys: 1 },
  ]);
  // Grace-retained entry is part of the in-memory embed set (no reread).
  deepEqual(first.embed.map((f) => f.url).sort(), ['/s/a.js', '/s/old.js']);
  const retained = first.embed.find((f) => f.url === '/s/old.js');
  equal(retained?.deployedAt, 1000);

  const second = await prepareDeploy({ manifests: [manifestPath], path, now: 3000 });
  deepEqual(
    second.plan.remove.map((f) => f.url),
    ['/s/old.js'],
  );
  equal(second.plan.pendingRemove.length, 0);
  equal(second.embed.length, 1);
});

test('plan with maxMissedDeploys: 1 deletes immediately, : 3 waits', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  writeManifest(manifestPath, []);

  const immediate = await prepareDeploy({
    manifests: [manifestPath],
    path,
    maxMissedDeploys: 1,
    now: 2000,
  });
  equal(immediate.plan.remove.length, 1);
});

test('maxMissedDeploys: 3 waits two cycles', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  writeManifest(manifestPath, []);

  const held = await prepareDeploy({
    manifests: [manifestPath],
    path,
    maxMissedDeploys: 3,
    now: 2000,
  });
  equal(held.plan.remove.length, 0);
  deepEqual(held.plan.pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', missedDeploys: 1 },
  ]);
  const again = await prepareDeploy({
    manifests: [manifestPath],
    path,
    maxMissedDeploys: 3,
    now: 3000,
  });
  equal(again.plan.remove.length, 0);
  deepEqual(again.plan.pendingRemove, [
    { source: manifestPath, path: 'dist/old.js', url: '/s/old.js', missedDeploys: 2 },
  ]);
  const last = await prepareDeploy({
    manifests: [manifestPath],
    path,
    maxMissedDeploys: 3,
    now: 4000,
  });
  equal(last.plan.remove.length, 1);
});

test('added manifest source uploads everything, removed source deletes under grace', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const jsPath = join(dir.path, 'js', 'manifest.json');
  const cssPath = join(dir.path, 'css', 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(jsPath, [jsEntry('/s/a.js', 'a.js', 'hash1')]);
  await prepareDeploy({ manifests: [jsPath], path, maxMissedDeploys: 1, now: 1000 });

  // New css source appears: all its entries upload, js entry unchanged.
  writeManifest(cssPath, [jsEntry('/s/b.css', 'b.css', 'hashB')]);
  const added = await prepareDeploy({
    manifests: [jsPath, cssPath],
    path,
    maxMissedDeploys: 1,
    now: 2000,
  });
  deepEqual(
    added.plan.add.map((f) => f.url),
    ['/s/b.css'],
  );
  equal(added.plan.unchanged, 1);

  // js source disappears: held for one grace cycle, then removed with its own dir.
  const removed = await prepareDeploy({ manifests: [cssPath], path, now: 3000 });
  equal(removed.plan.remove.length, 0);
  deepEqual(removed.plan.pendingRemove, [
    { source: jsPath, path: 'a.js', url: '/s/a.js', missedDeploys: 1 },
  ]);
  const gone = await prepareDeploy({ manifests: [cssPath], path, now: 4000 });
  deepEqual(
    gone.plan.remove.map((f) => f.url),
    ['/s/a.js'],
  );
  deepEqual(
    gone.plan.remove.map((f) => f.path),
    [join(dir.path, 'js', 'a.js')],
  );
  equal(gone.plan.unchanged, 1);
});

test('plan clears pending when the path reappears', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  writeManifest(manifestPath, []);
  const held = await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });
  equal(held.plan.pendingRemove.length, 1);
  // Path reappears with identical content: self-heals, keeps original timestamp.
  writeManifest(manifestPath, [jsEntry('/s/old.js', 'dist/old.js', 'hashOld')]);
  const healed = await prepareDeploy({ manifests: [manifestPath], path, now: 3000 });
  equal(healed.plan.pendingRemove.length, 0);
  equal(healed.plan.remove.length, 0);
  equal(healed.plan.unchanged, 1);
  equal(healed.embed[0]?.deployedAt, 1000);
});

test('prepareDeploy rejects invalid maxMissedDeploys and now', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  for (const maxMissedDeploys of [0, 1.5]) {
    let thrown = false;
    try {
      await prepareDeploy({ manifests: [manifestPath], path, maxMissedDeploys, now: 1000 });
    } catch (err) {
      thrown = true;
      ok(/maxMissedDeploys/.test((err as Error).message));
    }
    ok(thrown, `expected prepareDeploy to throw for maxMissedDeploys ${maxMissedDeploys}`);
  }
  let thrown = false;
  try {
    await prepareDeploy({ manifests: [manifestPath], path, now: 1.5 });
  } catch (err) {
    thrown = true;
    ok(/now/.test((err as Error).message));
  }
  ok(thrown, 'expected prepareDeploy to throw for non-integer now');
});

test('embed expands identity + variant rows with timestamps', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry('/s/a.js', 'dist/a.js', 'hash1', {
    headers: { 'Cache-Control': 'immutable' },
    compressed: {
      br: { path: 'dist/a.js.br', size: 5, sha256: 'brhash' },
      gz: { path: 'dist/a.js.gz', size: 6, sha256: 'gzhash' },
    },
  });
  const result = await prepareSingle(dir.path, [entry], { now: 1000 });
  const files = result.embed;
  equal(files.length, 3);
  equal(files[0]?.url, '/s/a.js');
  equal(files[0]?.encoding, undefined);
  equal(files[0]?.entry.mime, 'application/javascript');
  equal(files[0]?.entry.immutable, true);
  deepEqual(files[0]?.entry.headers, { 'Cache-Control': 'immutable' });
  equal(files[1]?.url, '/s/a.js.br');
  equal(files[1]?.path, join(dir.path, 'dist', 'a.js.br'));
  equal(files[1]?.encoding, 'br');
  equal(files[2]?.url, '/s/a.js.gz');
  equal(files[2]?.encoding, 'gz');
  for (const file of files) {
    equal(file.deployedAt, 1000);
  }
});

test('embed skips object urls unless external', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const entry = jsEntry(
    { origin: 'https://cdn.example', path: '/s/a.js' } as never,
    'dist/a.js',
    'hash1',
  );
  equal((await prepareSingle(dir.path, [entry], { now: 1000 })).embed.length, 0);
  const included = await prepareSingle(dir.path, [entry], { external: true, now: 2000 });
  equal(included.embed.length, 1);
  equal(included.embed[0]?.url, 'https://cdn.example/s/a.js');
});

test('embed carries absolute paths readable from disk', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'js', 'manifest.json');
  const rel = join('dist', 'a.js');
  mkdirSync(join(dir.path, 'js', 'dist'), { recursive: true });
  writeFileSync(join(dir.path, 'js', rel), 'hello');
  writeManifest(manifestPath, [jsEntry('/s/a.js', rel, 'hash1')]);
  const result = await prepareDeploy({
    manifests: [manifestPath],
    path: join(dir.path, 'manifest.deploy.json'),
    now: 1000,
  });
  const [file] = result.embed;
  ok(file !== undefined);
  equal(readFileSync(file.path, 'utf8'), 'hello');
  equal(dirname(file.path), join(dir.path, 'js', 'dist'));
});

test('plan uploads everything on first deploy', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const result = await prepareSingle(dir.path, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')], {
    now: 1000,
  });
  equal(result.plan.add.length, 1);
  equal(result.plan.remove.length, 0);
  equal(result.plan.pendingRemove.length, 0);
  equal(result.plan.unchanged, 0);
  equal(result.embed.length, 1);
});

test('plan remove includes variant rows with the parent', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  writeManifest(manifestPath, [
    jsEntry('/s/old.js', 'dist/old.js', 'hashOld', {
      compressed: { br: { path: 'dist/old.js.br', size: 4, sha256: 'brhash' } },
    }),
  ]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  writeManifest(manifestPath, []);
  const result = await prepareDeploy({
    manifests: [manifestPath],
    path,
    maxMissedDeploys: 1,
    now: 2000,
  });
  deepEqual(result.plan.remove.map((f) => f.url).sort(), ['/s/old.js', '/s/old.js.br']);
});

test('plan skips external removals unless external', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  const external = jsEntry(
    { origin: 'https://cdn.example', path: '/s/x.js' } as never,
    'dist/x.js',
    'hashX',
  );
  writeManifest(manifestPath, [external]);
  await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  writeManifest(manifestPath, []);
  // maxMissedDeploys: 2 so the intermediate cycle holds the entry under
  // grace (every call persists; a :1 cycle would flush it immediately).
  const plan = (
    await prepareDeploy({ manifests: [manifestPath], path, maxMissedDeploys: 2, now: 2000 })
  ).plan;
  equal(plan.remove.length, 0);
  const included = (
    await prepareDeploy({
      manifests: [manifestPath],
      path,
      maxMissedDeploys: 2,
      external: true,
      now: 3000,
    })
  ).plan;
  deepEqual(
    included.remove.map((f) => f.url),
    ['https://cdn.example/s/x.js'],
  );
});

test('embed rows carry source, current/retained partition, skippedExternal', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const path = join(dir.path, 'manifest.deploy.json');
  const external = jsEntry(
    { origin: 'https://cdn.example', path: '/s/x.js' } as never,
    'dist/x.js',
    'hashX',
  );
  writeManifest(manifestPath, [
    jsEntry('/s/a.js', 'dist/a.js', 'hash1'),
    jsEntry('/s/old.js', 'dist/old.js', 'hashOld'),
    external,
  ]);
  const first = await prepareDeploy({ manifests: [manifestPath], path, now: 1000 });
  equal(first.skippedExternal, 1);
  deepEqual(first.embed.map((f) => f.url).sort(), ['/s/a.js', '/s/old.js']);
  for (const file of first.embed) {
    equal(file.source, manifestPath);
  }
  deepEqual(first.retained, []);
  equal(first.current.length, first.embed.length);

  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1'), external]);
  const second = await prepareDeploy({ manifests: [manifestPath], path, now: 2000 });
  equal(second.skippedExternal, 1);
  deepEqual(
    second.current.map((f) => f.url),
    ['/s/a.js'],
  );
  deepEqual(
    second.retained.map((f) => f.url),
    ['/s/old.js'],
  );
  deepEqual(second.embed.map((f) => f.url).sort(), ['/s/a.js', '/s/old.js']);
  equal(second.retained[0]?.deployedAt, 1000);
  equal(second.retained[0]?.source, manifestPath);
});

test('prepareDeploy persists state to the configured path', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'naxe-deploy-'));
  const manifestPath = join(dir.path, 'manifest.json');
  const target = join(dir.path, 'elsewhere', 'deploy.json');
  writeManifest(manifestPath, [jsEntry('/s/a.js', 'dist/a.js', 'hash1')]);
  await prepareDeploy({ manifests: [manifestPath], path: target, now: 1000 });
  const reopened = await prepareDeploy({
    manifests: [manifestPath],
    path: target,
    now: 2000,
  });
  equal(reopened.plan.unchanged, 1);
});
