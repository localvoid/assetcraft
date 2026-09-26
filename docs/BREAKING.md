# Breaking changes

## Multi-entry APIs take `Manifest` (no bare entry lists)

`ManifestBuilder` (constructor / `import`), `diffManifests`, `pruneDir` / `collectManifestPaths`, and `validateManifestReferences` / `assertManifestReferences` now take `Manifest` (`Manifest | Manifest[]` for multi-input) instead of bare `readonly ManifestEntry[]` lists. Use `manifest.entries` for the raw entry list, `validateManifestEntries` to validate one, and `builder.toManifest()` to stamp the version when writing:

```ts
// Before
const builder = new ManifestBuilder(prev.entries);
builder.import(externalEntries);
await pruneDir(outDir, entries, { ignore: ['manifest.js.json'] });
await updateFile('dist/manifest.js.json', JSON.stringify({ version: 1, entries: builder.entries }));

// After
const builder = new ManifestBuilder(prev);
builder.import(externalManifest);
await pruneDir(outDir, manifest, { ignore: ['manifest.js.json'] });
await updateFile('dist/manifest.js.json', JSON.stringify(builder.toManifest()));
```

`diffManifests(prev, next)` takes two manifests; `validateManifestReferences([appManifest, vendorManifest])` takes manifests too. Deploy snapshots are versioned (`ManifestSnapshot extends Manifest`: `{ source, dir, version, entries }`); old deploy-state files without snapshot `version` still read (assumed version 1), while snapshots with an unsupported `version` throw — re-run deploys to rewrite state.

## `ManifestEnvelope` is now `Manifest`

The versioned wrapper (`{ version, entries }`) is now called `Manifest`. There is no special type for an entry list — use `manifest.entries` (and `validateManifestEntries` to validate one). Multi-entry pipeline APIs take `Manifest` directly (see above).

- `ManifestEnvelope` → `Manifest`; `Manifest` (entry-list alias) is removed.
- `validateManifestEnvelope` → `validateManifest` (`manifest must be an object with version and entries`; throws `Invalid manifest: ...`); `assertManifestEnvelope` → `assertManifest`.
- `validateManifest` (entry list) → `validateManifestEntries` (`entries must be an array`, per-index `[i] ...`). `parseManifest` / `importManifests` now return `Manifest`.

```ts
const prev = parseManifest(await readFile('dist/manifest.js.json', 'utf8'));
const builder = new ManifestBuilder(prev);
builder.import(externalManifest);
```

## Manifest files are versioned envelopes

Manifest files on disk are now versioned (`Manifest { version, entries }`, current `MANIFEST_VERSION = 1`) instead of bare entry arrays. Pipeline APIs take `Manifest` (see above); old bare-array manifest files must be re-emitted (or wrapped) — they no longer parse.

Before (`dist/manifest.js.json`):

```json
[{ "type": "js", "mime": "application/javascript" }]
```

After:

```json
{ "version": 1, "entries": [{ "type": "js", "mime": "application/javascript" }] }
```

### 1. Write manifests with `toManifest()`

```ts
await updateFile('dist/manifest.js.json', JSON.stringify(builder.toManifest(), null, 2));
```

### 2. Pass manifests directly after reading

`parseManifest` now returns a `Manifest` (throws on bad JSON or an invalid manifest — see `validateManifest` / `assertManifest`); `importManifests` returns manifests the same way:

```ts
const prev = parseManifest(await readFile('dist/manifest.js.json', 'utf8'));
const builder = new ManifestBuilder(prev);
```

`prepareDeploy` reads manifests and is unchanged otherwise.

## Compression moved out of entry creation

`createManifestEntry` (and its `CreateManifestEntryOptions` / `CreateManifestEntryResult` types) is removed from `assetcraft/manifest/build`. Compressing while creating entries coupled hashing/metadata with CPU-heavy encoding and forced callers to write variant buffers by hand.

`assetcraft/manifest/build` now exports only `ManifestBuilder`, `urlSafeSHA256`, `computeIntegrity`, `createPathFormatter` (`CreatePathFormatterOptions`, `PathFormatter`), `IntegrityAlgorithm`, and `ManifestEntryFor`.

### 1. Build entries by hand instead of `createManifestEntry`

Before:

```ts
import { createManifestEntry } from 'assetcraft/manifest/build';

const { entry, variants } = await createManifestEntry({
  type: 'js',
  mime: 'application/javascript',
  content: code,
  path: 'assets/app.js',
  name: 'app',
  compress: true,
  extra: { module: 'esm', entry: true },
});
builder.add(entry);
await writeFile(join(outDir, entry.path), code);
for (const [format, data] of Object.entries(variants)) {
  const meta = entry.compressed?.[format as keyof typeof variants];
  if (meta) await writeFile(join(outDir, meta.path), data);
}
```

After:

```ts
import { computeIntegrity, urlSafeSHA256 } from 'assetcraft/manifest/build';

const bytes = new TextEncoder().encode(code);
const path = 'assets/app.js';
builder.add({
  type: 'js',
  mime: 'application/javascript',
  url: `/${path}`,
  path,
  sha256: urlSafeSHA256(bytes),
  size: bytes.length,
  immutable: true,
  integrity: computeIntegrity(bytes, 'sha384'),
  name: 'app',
  module: 'esm',
  entry: true,
});
await writeFile(join(outDir, path), bytes);
```

Helpers: `url: '/' + path` unless the URL scheme differs from disk layout; `immutable: true` unless the URL is mutable; omit `integrity` when SRI is not needed. Type-specific fields (`module`, `media`, `match`, …) go directly on the entry — there is no `extra` wrapper anymore.

### 2. Compress in the deploy script

`entry.compressed` is no longer set at build time. Entries carry intent (`compressible?: boolean`); the deploy script performs encoding — it may also rewrite relative paths or merge manifests before compressing:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compressAsset, isCompressible } from 'assetcraft/compress';
import { urlSafeSHA256 } from 'assetcraft/manifest/build';
import { updateFile } from 'assetcraft/file';

await writeFile(join(outDir, path), bytes); // identity files first

const manifest = [];
for (const entry of builder.entries) {
  const selected = entry.compressible ?? isCompressible(entry);
  if (!selected) {
    manifest.push(entry);
    continue;
  }
  const content = await readFile(join(outDir, entry.path));
  const variants = await compressAsset(content); // sizeMin / sizeMinDiffRatio thresholds + br/zst/gz overrides
  const compressed = {};
  for (const [format, data] of Object.entries(variants)) {
    const variantPath = `${entry.path}.${format}`;
    await writeFile(join(outDir, variantPath), data);
    compressed[format] = { path: variantPath, size: data.length, sha256: urlSafeSHA256(data) };
  }
  manifest.push(Object.keys(compressed).length > 0 ? { ...entry, compressed } : entry);
}
await updateFile(
  'dist/manifest.json',
  JSON.stringify({ version: 1, entries: manifest }, null, 2),
);
```

Only variants meeting the `sizeMin` / `sizeMinDiffRatio` threshold are kept (`<path>.br`, `<path>.zst`, `<path>.gz`).

### 3. `compressible` tri-state + `isCompressible` replace `compress: true`

| Before                      | After                                                      |
| --------------------------- | ---------------------------------------------------------- |
| `compress: true`            | `compressible: true` on the entry, or rely on the default  |
| `compress: { sizeMin, … }`  | thresholds passed to `compressAsset(content, { sizeMin })` |
| never compressed by default | text-like types compress by default (see below)            |

Decision order per entry in the deploy script:

1. `entry.compressible === true` → always try (subject to thresholds).
2. `entry.compressible === false` → never.
3. `entry.compressible === undefined` → deploy script's own filter `?? isCompressible(entry)`.

`isCompressible(entry)` (from `assetcraft/compress`) is the type/mime default: `js`, `wasm`, `html`, `css`, `svg`, `text`, `sourcemap` compress; `font`, `image`, `audio`, `video`, `compression-dictionary` do not; `binary` (and unknown future types) compress only for text-like mimes (`text/*`, `*+json`, `*+xml`, `application/javascript`, `application/json`, `application/manifest+json`, `application/xml`, `application/xhtml+xml`). Wrap it to override selectively:

```ts
import { isCompressible } from 'assetcraft/compress';

const selected = entry.compressible ?? shouldCompress?.(entry) ?? isCompressible(entry);
// e.g. shouldCompress = (entry) => (entry.path.endsWith('.dat') ? false : isCompressible(entry))
```

`validateManifestEntry` now enforces `compressible: boolean` when present. `prepareDeploy` and HTTP helpers are unchanged — they keep reading the `compressed` records produced by the deploy script.
