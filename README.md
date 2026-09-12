# assetcraft

TypeScript toolkit for managing static web assets: content-hashed manifests, compression variants, safe pruning, immutable-URL deploy history, and HTTP serving headers.

- **Manifest** — typed entries for JS, CSS, images, fonts, HTML, WASM, and more, with hashing, SRI, and lookup indices.
- **Compression** — Brotli, Zstandard, and gzip variants with savings thresholds.
- **Prune / Diff / Validate** — clean stale hashed files, diff builds, validate JSON manifests.
- **Deploy** — multi-manifest upload/delete planning with immutable-URL collision protection and deletion grace (version skew/deployment drift).
- **HTTP** — `Cache-Control`, `ETag`, `Content-Encoding`, and `Link: rel=preload` header builders.
- **File** — hashing, hashed filenames, conditional writes, directory cleaning.

ESM-only (`"type": "module"`, `sideEffects: false`). Ships `dist/` + `src/`. Requires Node with `zlib.zstdCompress` (Node 22+).

## Installation

```bash
npm install assetcraft
```

## Lifecycle overview

```text
source files
  -> createManifestEntry (hash, size, hashed path, SRI, compress)
  -> ManifestBuilder.add/upsert (+ import external manifests)
  -> write files + variants to disk, write manifest JSON
  -> pruneDir (delete stale hashed outputs)
```

Entry `path` is the output-relative disk path. Entry `url` is the public URL (string, or `{ origin, path }` for CDN/external). Immutable entries must never reuse a URL for different content — `ManifestBuilder` and `Deploy` throw on collision.

## Quickstart

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ManifestBuilder } from 'assetcraft/manifest/build';
import { createManifestEntry } from 'assetcraft/manifest/entry';
import { pruneDir } from 'assetcraft/manifest/prune';
import { updateFile } from 'assetcraft/file';

const outDir = 'dist';
const builder = new ManifestBuilder();

const code = await readFile('src/app.js', 'utf8');
const { entry, variants } = await createManifestEntry({
  type: 'js',
  mime: 'application/javascript',
  content: code,
  path: 'assets/app.js', // -> assets/app-<12-char-hash>.js
  name: 'app',
  compress: true, // default thresholds; see below
  extra: { module: 'esm', entry: true },
});
builder.add(entry);

// Write identity + variants. Variant buffers must be written by the caller
// to entry.compressed[format].path.
await mkdir(join(outDir, dirname(entry.path)), { recursive: true });
await writeFile(join(outDir, entry.path), code);
for (const [format, data] of Object.entries(variants)) {
  const meta = entry.compressed?.[format as keyof typeof variants];
  if (meta) await writeFile(join(outDir, meta.path), data);
}

await updateFile('dist/manifest.js.json', JSON.stringify(builder.entries, null, 2));

// Delete stale hashed files left by previous builds.
// Entries are relative to `dist`, so prune `dist` and keep the manifest itself.
await pruneDir(outDir, builder.entries, {
  ignore: ['manifest.js.json'],
  compressedSuffixes: ['.br', '.zst', '.gz'],
});
```

Then deploy and serve (see `Deploy` and `Serving` sections).

## Manifest entries

`assetcraft/manifest` exports the `Manifest` (`ManifestEntry[]`), `ManifestIndex`, per-type interfaces, `urlToString`, and `importManifests`.

Entry types (`ManifestEntryType`): `js`, `wasm`, `html`, `css`, `font`, `image`, `svg`, `audio`, `video`, `text`, `binary`, `sourcemap`, `compression-dictionary`.

Common base fields:

| Field | Meaning |
| --- | --- |
| `type`, `mime` | Discriminant + `Content-Type` source |
| `url: string \| { origin, path }` | Public URL. Object form is origin-scoped (`origin + path` is the identity key) |
| `path` | Output-relative disk path (hashed when built via helper) |
| `sha256` | Base64url SHA-256 of identity content |
| `size` | Identity bytes (`Content-Length` source) |
| `immutable?` | `true` = URL never serves different bytes; gets long-lived immutable `Cache-Control` |
| `name?: string \| string[]` | Logical lookup key(s) |
| `tags?: string[]` | Grouping/filtering |
| `headers?: Record<string,string>` | Merged last in `buildResponseHeaders`; overrides generated values (except `Link`, which is concatenated) |
| `integrity?` | SRI string (`sha256-…`/`sha384-…`/`sha512-…`) |
| `compressed?` | `{ br/zst/gz?: { path, size, sha256? } }` |
| `crossorigin?`, `fetchPriority?` | HTML generation hints |
| `preload?: ManifestPreload[]` | Rendered as `Link: <url>; rel=preload; …` |

Per-type extras (e.g. `ManifestJSEntry.module/entry/async/defer/deps`, `ManifestImageEntry.width/height/srcset/loading/decoding`, `ManifestFontEntry.family/weight/style/display`, `ManifestVideoEntry.poster/duration`, `ManifestHTMLEntry.title/lang/isEntry/isFallback`, `ManifestSourceMapEntry.source`, `ManifestCompressionDictionaryEntry.match/matchDest`) are in `src/manifest.ts`. Check `isManifestEntryType(type)` to narrow unknown input.

`urlToString(url)` normalizes both URL forms. `importManifests([paths])` dynamically imports JSON manifests with `{ with: { type: 'json' } }` and returns `{ path, manifest }[]` in order.

## Building entries: `assetcraft/manifest/entry`

`createManifestEntry({ type, mime, content, path, ... })` measures `size`, hashes `sha256`, derives hashed `path`/`url`, computes `integrity`, optionally compresses.

Defaults:

- `immutable: true` unless `immutable: false` is passed.
- `pathHash: true` (12-char hash prefix before extension: `app.js` -> `app-a1b2c3d4e5f6.js`). Pass `false` to disable or a number for custom length (`pathHash: 8`).
- `integrity: 'sha384'` unless `false`. Algorithms: `sha256 | sha384 | sha512`.
- `url: '/' + path` unless explicit. Pass a string or `{ origin, path }` when CDN layout differs from disk layout.
- `compress: false`. Pass `true` or `CompressAssetOptions`.

```ts
import { createManifestEntry } from 'assetcraft/manifest/entry';

const { entry, variants } = await createManifestEntry({
  type: 'css',
  mime: 'text/css',
  content: css,
  path: 'assets/style.css',
  url: 'https://cdn.example/assets/style.css',
  immutable: false, // mutable URL: must revalidate
  name: 'style',
  tags: ['app'],
  compress: { sizeMin: 1024, sizeMinDiffRatio: 0.2 },
  extra: { media: 'screen' },
});
// variants: { br?: Buffer, zst?: Buffer, gz?: Buffer } — only threshold-passing formats.
// entry.compressed[format] = { path: entry.path + '.' + format, size, sha256 }.
```

Type-specific fields go in `extra` (typed as `Omit<ManifestEntryFor<T>, ManagedKeys>`). `compression-dictionary` requires `extra: { match: '*.js', matchDest?: '...' }`. Result always passes `validateManifestEntry`.

## Building manifests: `assetcraft/manifest/build`

```ts
import { readFile } from 'node:fs/promises';
import { ManifestBuilder } from 'assetcraft/manifest/build';
import { parseManifest } from 'assetcraft/manifest/validate';

const prev = parseManifest(await readFile('dist/manifest.js.json', 'utf8').catch(() => '[]'));
const builder = new ManifestBuilder(prev);
builder.add(entry); // returns index; throws on duplicate path/name or URL+other-hash
builder.upsert(entry); // replace by path, keep position; failed upsert leaves old entry
builder.import(externalManifest); // index-only, not in `.entries`; locals shadow by key
builder.updateByPath('assets/old.js', (e) => ({ ...e, headers: { 'x-v': '1' } }));

builder.getByName('app');
builder.getByPath('assets/app-abc123.js');
builder.getByURL('/assets/app-abc123.js'); // object URLs keyed as origin+path
builder.getByTag('app'); // locals first, then unshadowed externals
builder.listByType('js');
await updateFile('dist/manifest.js.json', JSON.stringify(builder.entries, null, 2));
```

Rules: duplicate `path` always throws; duplicate `name` throws; same URL with different `sha256` throws; same URL with same hash is idempotent. External entries are visible to lookups but `builder.entries` contains only locals.

## Validate: `assetcraft/manifest/validate`

For JSON files, external manifests, and previous-build artifacts:

```ts
import {
  assertManifestEntry,
  isManifestEntryType,
  parseManifest,
  validateManifest,
  validateManifestEntry,
} from 'assetcraft/manifest/validate';

validateManifestEntry(unknown); // string[] problems, [] = valid
assertManifestEntry(unknown); // throws `Invalid manifest entry: ...`
validateManifest(unknown); // per-index `[i] ...` problems
parseManifest(jsonText); // throws on bad JSON / non-array / invalid entries
isManifestEntryType(type); // type guard
```

Enforced: non-empty `mime`/`path`/`url`, base64url `sha256` (no `+`/`/`/`=`), non-negative integer `size`, SRI format, `compressed` keys limited to `br|zst|gz`, `match` for `compression-dictionary`.

## Diff: `assetcraft/manifest/diff`

```ts
import { diffManifests } from 'assetcraft/manifest/diff';

const diff = diffManifests(prev, next);
// { added, removed, changed: { prev, next, hashChanged }[], unchanged }
// Keyed by path. changed with hashChanged:false = metadata-only (no re-upload needed).
```

`Deploy.plan()` uses this per manifest source internally.

## Prune: `assetcraft/manifest/prune`

Removes files under `dir` not referenced by manifest(s). Validates everything before deleting — on throw, nothing is deleted.

```ts
import { collectManifestPaths, pruneDir } from 'assetcraft/manifest/prune';

await pruneDir('dist/assets', [jsManifest, cssManifest], {
  ignore: ['static/', 'robots.txt'], // extra output-relative keeps; trailing / keeps subtree
  compressedSuffixes: ['.br', '.zst', '.gz'], // keep suffix-convention files alongside entries
  removeEmptyDirs: true, // default false; root dir is never removed
});

collectManifestPaths(manifests, dir, { compressedSuffixes: [...] }); // Set<string> of keeps
```

Notes: `entry.compressed[*].path` is always kept; `compressedSuffixes` additionally keeps `path+suffix` for untracked on-disk files. Paths must be output-relative posix (`./`, `a/../` normalized); empty, absolute, self (`.`), escaping (`../x`), and separator-containing suffixes throw. Symlinks are removed, never followed.

## Compress: `assetcraft/compress`

Each format tried independently; only variants saving at least `sizeMinDiffRatio` are returned.

```ts
import { compressAsset, compressAssetSync } from 'assetcraft/compress';

const variants = await compressAsset(content, {
  sizeMin: 512, // default: skip smaller inputs
  sizeMinDiffRatio: 0.1, // default: keep variant only if < 90% of original
  br: { params: {/* overrides; default max quality, TEXT mode, size hint */} },
  zst: { params: {/* overrides; default level 22, btultra2 */} },
  gz: { level: 9 }, // default best compression
});
// variants: { br?: Buffer, zst?: Buffer, gz?: Buffer }
const sync = compressAssetSync(content, { sizeMin: 2048 });
```

`CompressFormat = 'br' | 'zst' | 'gz'` are file-suffix keys (`'.' + format`); `getContentEncoding(format)` in `assetcraft/http` maps them to HTTP `Content-Encoding` (`br`→`br`, `zst`→`zstd`, `gz`→`gzip`).

## Deploy: `assetcraft/deploy`

`prepareDeploy`: one manifest path per build tool; previous manifests are restored from deploy state, so callers never pass them directly. The full embed set (current + grace-retained entries) is returned in-memory — never re-read the state file.

```ts
import { prepareDeploy } from 'assetcraft/deploy';

const { plan, embed, snapshots, deployedAt } = await prepareDeploy({
  manifests: ['dist/manifest.html.json', 'dist/manifest.js.json'],
  path: 'pub/deploy.json', // state sidecar (history + pending + snapshots + deployedAt)
  maxMissedDeploys: 2, // default 2; 1 = delete immediately
  external: false, // default: skip { origin, path } entries in plan/embed
  purgeDuration: 31536000, // default 365d history retention for inactive URLs, seconds
  now: Math.floor(Date.now() / 1000), // default: current unix seconds
});

for (const file of plan.add) {
  // file: { url, path (absolute), size, sha256, encoding, entry, deployedAt, source }
  // encoding: undefined (identity) | 'br' | 'zst' | 'gz'
  // deployedAt: unix seconds of the cycle that first deployed this content
  // upload file.path -> file.url (+ Content-Encoding when encoding set)
}
for (const file of plan.remove) {
  // delete file.url
}
// embed: plan-independent full set to serve/bundle (current + retained),
// with absolute paths; snapshots: exactly what was persisted as prevManifests.
```

Details:

- `embed` expands identity + recorded `entry.compressed` variants. Variant URLs are `url + .br/.zst/.gz`. Paths resolve against each manifest's own directory. Sources combine in `manifests` order; same relative `path` in different manifests stays distinct (keyed by source + path); URLs share one global history namespace. Snapshot `dir` is resolve-only: retargeting it (e.g. at a bundle dir) never affects diffing.
- `plan` is `{ add, remove, pendingRemove, unchanged }`. First deploy uploads everything. Hash-changed paths upload; metadata-only changes do not. Removals wait `maxMissedDeploys` consecutive missing cycles (survives one stale-HTML window), reappearing paths self-heal, removed manifest sources drain under the same grace.
- `deployedAt` stamps new content with `now` and carries the original timestamp for unchanged/retained content (persisted per source + path).
- Safety: missing state = first deploy; corrupt state, missing/invalid manifest, duplicate manifest path, bad `maxMissedDeploys`/`now`, or immutable URL reuse with different `sha256` all throw (`Hash collision detected ...`). Mutable entries are ignored by history. Object URLs are history-tracked but excluded from `plan`/`embed` unless `external: true`.

## Serving: `assetcraft/http`

Http helpers for dev servers and deploy pipelines. Production servers should precompile headers before deployment.

```ts
import { buildResponseHeaders, getCacheControl, getContentEncoding, getETag } from 'assetcraft/http';

getCacheControl(entry); // immutable: public, max-age=31536000, immutable
// mutable: public, max-age=0, must-revalidate
// options: { immutableMaxAge?, mutableMaxAge? }
getETag(entry); // `"<sha256>"`, compare against If-None-Match directly
getContentEncoding('zst'); // 'zstd' (br→br, gz→gzip)

const headers = buildResponseHeaders(entry, {
  cacheControl: true, // default true
  contentLength: true, // default true; uses variant size when encoding matches
  etag: true, // default true
  link: true, // default true; renders entry.preload
  encoding: 'br', // adds Content-Encoding + Vary: Accept-Encoding
  variantSize: 1234, // override Content-Length (defaults to entry.compressed[encoding].size)
});
// entry.headers merged last and win; generated Link is prepended to user Link with ", ".
```

Preloads (`ManifestPreload { url, as?, crossorigin?, fetchPriority?, media? }`):

```ts
import { getLinkHeader, getPreloadLink, getPreloadAs } from 'assetcraft/http';

getPreloadAs('js'); // script | style | font | image | audio | video | document | fetch | undefined
getPreloadLink('/fonts/body.woff2', { as: 'font' });
// </fonts/body.woff2>; rel=preload; as=font; crossorigin=anonymous (font default)
getLinkHeader(entry.preload); // joined with ", ", undefined when empty
```

Serving flow: map `Accept-Encoding` (`br`/`zstd`/`gzip`) to `entry.compressed` keys (`br`/`zst`/`gz`), pass the key to `buildResponseHeaders` (which emits the correct `Content-Encoding` via `getContentEncoding`), stream `entry.path` (identity) or `entry.compressed[encoding].path` with the returned headers. Do not hand-write `Link` in `entry.headers` when `preload` already covers it.

## File utilities: `assetcraft/file`

```ts
import {
  calculateHash,
  cleanDir,
  cleanDirRecursive,
  formatFileSize,
  normalizeRelativePath,
  pathIsWithin,
  pathWithTrailingSlash,
  uniqueFileName,
  updateFile,
} from 'assetcraft/file';

calculateHash('hello'); // base64url SHA-256
uniqueFileName('style.css', hash); // style-<12-char-hash>.css
await updateFile('dist/manifest.json', json); // mkdir -p, write only if changed; returns boolean
await cleanDir('dist', new Set(['keep.txt'])); // top-level files/symlinks only
await cleanDirRecursive('dist', ['sub/keep.txt', 'static/'], { removeEmptyDirs: true });
normalizeRelativePath('./a//b/../c'); // { ok:true, path:'a/c' } or { ok:false, reason }
pathIsWithin('/out', '/out/a.js'); // resolved containment check
pathWithTrailingSlash('/static'); // '/static/'
formatFileSize(1536); // '1.50KB'
```

`cleanDirRecursive` keep paths are output-relative posix; trailing `/` keeps the subtree; exact-name match keeps file/symlink/tree without descending; invalid entries (empty/absolute/escaping) never match.

## Submodule reference

| Specifier | Exports |
| --- | --- |
| `assetcraft/manifest` | Types, `urlToString`, `importManifests` |
| `assetcraft/manifest/entry` | `createManifestEntry`, `CreateManifestEntryOptions/Result`, `IntegrityAlgorithm` |
| `assetcraft/manifest/build` | `ManifestBuilder` |
| `assetcraft/manifest/validate` | `validateManifestEntry`, `assertManifestEntry`, `validateManifest`, `parseManifest`, `isManifestEntryType` |
| `assetcraft/manifest/diff` | `diffManifests`, `ManifestDiff`, `ManifestChangedEntry` |
| `assetcraft/manifest/prune` | `pruneDir`, `collectManifestPaths`, `PruneOptions` |
| `assetcraft/compress` | `compressAsset`, `compressAssetSync`, `CompressAssetOptions/Result`, `CompressFormat` |
| `assetcraft/deploy` | `prepareDeploy`, `PrepareDeployOptions/Result`, `DeployPlan/File`, `DeployHistoryEntry`, `PendingRemoval`, `ManifestSnapshot` |
| `assetcraft/http` | `getCacheControl`, `getContentEncoding`, `getETag`, `getPreloadAs`, `getPreloadLink`, `getLinkHeader`, `buildResponseHeaders` + option types |
| `assetcraft/file` | Hashing, naming, `updateFile`, cleaning, path helpers, `formatFileSize` |

## Commands

- `bun run build` — compile to `dist/`
- `bun run check` — type-aware lint (oxlint + oxlint-tsgolint)
- `bun test tests/` — test suite
- `bun run format` — format

## License

MIT OR Apache-2.0
