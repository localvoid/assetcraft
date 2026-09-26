# assetcraft

TypeScript toolkit for managing static web assets: content-hashed manifests, compression variants, safe pruning, immutable-URL deploy history, and HTTP serving headers.

- **Manifest** — typed entries for JS, CSS, images, fonts, HTML, WASM, and more, with hashing, SRI, and lookup indices.
- **Compression** — Brotli, Zstandard, and gzip variants with savings thresholds.
- **Prune / Diff / Validate** — clean stale hashed files, diff builds, validate JSON manifests.
- **Deploy** — multi-manifest upload/delete planning with immutable-URL collision protection and deletion grace (version skew/deployment drift).
- **HTTP** — `Cache-Control`, `ETag`, `Content-Encoding`, and `Link: rel=preload` header builders.
- **File** — hashed filenames, conditional writes, directory cleaning.

ESM-only (`"type": "module"`, `sideEffects: false`). Ships `dist/` + `src/`. Requires Node with `zlib.zstdCompress` (Node 22+).

## Installation

```bash
npm install assetcraft
```

## Lifecycle overview

```text
source files
  -> createPathFormatter (optional content-hashed path)
  -> build entries by hand (hash with urlSafeSHA256, SRI with computeIntegrity)
  -> ManifestBuilder.add/upsert (+ import external manifests)
  -> write identity files, then compress in the deploy script
  -> (compressAsset + isCompressible, record entry.compressed)
  -> write manifest JSON (possibly merged/rewritten paths)
  -> pruneDir (delete stale hashed outputs)
```

Entry `path` is the output-relative disk path. Entry `url` is the public URL (string, or `{ origin, path }` for CDN/external). Immutable entries must never reuse a URL for different content — `ManifestBuilder` and `Deploy` throw on collision.

## Quickstart

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ManifestBuilder, computeIntegrity, urlSafeSHA256 } from 'assetcraft/manifest/build';
import { compressAsset, isCompressible } from 'assetcraft/compress';
import { pruneDir } from 'assetcraft/manifest/prune';
import { updateFile } from 'assetcraft/file';

const outDir = 'dist';
const builder = new ManifestBuilder();

const bytes = await readFile('src/app.js');
const path = 'assets/app.js'; // used as-is; pre-format with createPathFormatter for hashing
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

// Write identity, then compress in the deploy script. For each selected
// entry, encode variants and record them in entry.compressed.
const entry = builder.getByPath(path)!;
await mkdir(join(outDir, dirname(entry.path)), { recursive: true });
await writeFile(join(outDir, entry.path), bytes);

const manifest = [];
for (const e of builder.entries) {
  const selected = e.compressible ?? isCompressible(e);
  if (!selected) {
    manifest.push(e);
    continue;
  }
  const content = await readFile(join(outDir, e.path));
  const variants = await compressAsset(content);
  const compressed = {};
  for (const [format, data] of Object.entries(variants)) {
    const variantPath = `${e.path}.${format}`;
    await writeFile(join(outDir, variantPath), data);
    compressed[format] = { path: variantPath, size: data.length, sha256: urlSafeSHA256(data) };
  }
  manifest.push(Object.keys(compressed).length > 0 ? { ...e, compressed } : e);
}

await updateFile('dist/manifest.js.json', JSON.stringify(manifest, null, 2));

// Delete stale hashed files left by previous builds.
// Entries are relative to `dist`, so prune `dist` and keep the manifest itself.
await pruneDir(outDir, manifest, {
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
| `path` | Output-relative disk path (use `createPathFormatter` for content-hashed names) |
| `sha256` | Base64url SHA-256 of identity content |
| `size` | Identity bytes (`Content-Length` source) |
| `immutable?` | `true` = URL never serves different bytes; gets long-lived immutable `Cache-Control` |
| `name?: string \| string[]` | Logical lookup key(s) |
| `tags?: string[]` | Grouping/filtering |
| `headers?: Record<string,string>` | Merged last in `buildResponseHeaders`; overrides generated values (except `Link`, which is concatenated) |
| `integrity?` | SRI string (`sha256-…`/`sha384-…`/`sha512-…`, via `computeIntegrity`) |
| `compressible?` | Compression intent for the deploy script (`true`/`false`/`undefined` = auto via `isCompressible`); `compressed?` is recorded by the deploy script |
| `compressed?` | `{ br/zst/gz?: { path, size, sha256? } }` |
| `crossorigin?`, `fetchPriority?` | HTML generation hints |
| `preload?: ManifestPreload[]` | Rendered as `Link: <url>; rel=preload; …` |
| `symbols?` | Path or URL of the external debug information for this asset |

Per-type extras (e.g. `ManifestJSEntry.module/entry/async/defer/deps`, `ManifestImageEntry.width/height/srcset/loading/decoding`, `ManifestFontEntry.family/weight/style/display`, `ManifestVideoEntry.poster/duration`, `ManifestHTMLEntry.title/lang/isEntry/isFallback`, `ManifestSourceMapEntry.source`, `ManifestCompressionDictionaryEntry.match/matchDest`) are in `src/manifest.ts`. Check `isManifestEntryType(type)` to narrow unknown input.

`urlToString(url)` normalizes both URL forms. `importManifests([paths])` dynamically imports JSON manifests with `{ with: { type: 'json' } }` and returns `{ path, manifest }[]` in order.

## Building manifests: `assetcraft/manifest/build`

`urlSafeSHA256(content)` computes the base64url SHA-256 used for `sha256` fields and content-hashed paths. `computeIntegrity(content, algo)` computes the SRI string (`sha256 | sha384 | sha512`).

```ts
import { urlSafeSHA256, computeIntegrity, createPathFormatter } from 'assetcraft/manifest/build';

// Optional: build a content-hashed path before creating the entry.
// Options: { dir?: string, hash?: number } (hash length, default 12).
const formatPath = createPathFormatter({ dir: 'assets', hash: 8 });
const bytes = new TextEncoder().encode(code);
const path = formatPath({ path: 'src/app.js' } as never, urlSafeSHA256(bytes));
// -> assets/app-<8-char-hash>.js
const entry = {
  type: 'js',
  mime: 'application/javascript',
  url: `/${path}`,
  path,
  sha256: urlSafeSHA256(bytes),
  size: bytes.length,
  immutable: true,
  integrity: computeIntegrity(bytes, 'sha384'),
} as const;
```

Type-specific fields go directly on the entry. `compression-dictionary` requires `match: '*.js'` (`matchDest?` optional). Validate the result with `validateManifestEntry`.

`ManifestBuilder` accumulates entries and maintains lookup indices:

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

`isCompressible(entry)` is the type/mime default for deploy scripts (`js`, `wasm`, `html`, `css`, `svg`, `text`, `sourcemap` yes; `font`, `image`, `audio`, `video`, `compression-dictionary` no; `binary` by text-like mime). Combine it with the per-entry intent: `entry.compressible ?? shouldCompress?.(entry) ?? isCompressible(entry)`, where `shouldCompress` is the deploy script's own filter. The script may also rewrite relative paths or merge manifests before encoding — that stays outside this library.

## Deploy: `assetcraft/deploy`

`prepareDeploy`: one manifest path per build tool; previous manifests are restored from deploy state, so callers never pass them directly. The full embed set (current + grace-retained entries) is returned in-memory — never re-read the state file.

```ts
import { prepareDeploy } from 'assetcraft/deploy';

const { plan, embed, snapshots, deployedAt } = await prepareDeploy({
  manifests: ['dist/manifest.html.json', 'dist/manifest.js.json'],
  path: 'pub/deploy.json', // state sidecar (history + pending + snapshots + deployedAt + seed)
  maxMissedDeploys: 2, // default 2; 1 = delete immediately
  external: false, // default: skip { origin, path } entries in plan/embed
  purgeDuration: 31536000, // default 365d history retention for inactive URLs, seconds
  seed: { key: 'releases/app-r42.tar', sha256: '<hex>' }, // optional lineage; undefined preserves, null clears
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
- `seed: DeploySeed | null` (`{ key, sha256 }`) records which seed bundle the cycle resolved history from. Omitted (`undefined`) preserves the loaded value; explicit `null` clears it for a fresh cycle. Fresh state without a seed persists `seed: null`. Malformed stored seeds throw (`seed needs string key/sha256`).
- Safety: missing state = first deploy; corrupt state, missing/invalid manifest, duplicate manifest path, bad `maxMissedDeploys`/`now`, or immutable URL reuse with different `sha256` all throw (`Hash collision detected ...`). Mutable entries are ignored by history. Object URLs are history-tracked but excluded from `plan`/`embed` unless `external: true`.

## Serving: `assetcraft/http`

Http helpers for dev servers and deploy pipelines. Production servers should precompile headers before deployment.

```ts
import {
  buildResponseHeaders,
  getCacheControl,
  getContentEncoding,
  getETag,
} from 'assetcraft/http';

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
  cleanDir,
  cleanDirRecursive,
  formatFileSize,
  normalizeRelativePath,
  pathIsWithin,
  pathWithTrailingSlash,
  uniqueFileName,
  updateFile,
} from 'assetcraft/file';

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
| `assetcraft/manifest/build` | `ManifestBuilder`, `urlSafeSHA256`, `computeIntegrity`, `createPathFormatter`, `CreatePathFormatterOptions`, `PathFormatter`, `IntegrityAlgorithm`, `ManifestEntryFor` |
| `assetcraft/manifest/validate` | `validateManifestEntry`, `assertManifestEntry`, `validateManifest`, `parseManifest`, `isManifestEntryType` |
| `assetcraft/manifest/diff` | `diffManifests`, `ManifestDiff`, `ManifestChangedEntry` |
| `assetcraft/manifest/prune` | `pruneDir`, `collectManifestPaths`, `PruneOptions` |
| `assetcraft/compress` | `compressAsset`, `compressAssetSync`, `isCompressible`, `CompressAssetOptions/Result`, `CompressFormat` |
| `assetcraft/deploy` | `prepareDeploy`, `PrepareDeployOptions/Result`, `DeployPlan/File`, `DeploySeed`, `DeployHistoryEntry`, `PendingRemoval`, `ManifestSnapshot` |
| `assetcraft/http` | `getCacheControl`, `getContentEncoding`, `getETag`, `getPreloadAs`, `getPreloadLink`, `getLinkHeader`, `buildResponseHeaders` + option types |
| `assetcraft/file` | Naming, `updateFile`, cleaning, path helpers, `formatFileSize` |

## Commands

- `bun run build` — compile to `dist/`
- `bun run check` — type-aware lint (oxlint + oxlint-tsgolint)
- `bun test tests/` — test suite
- `bun run format` — format

## License

MIT OR Apache-2.0
