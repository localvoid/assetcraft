# assetcraft

TypeScript toolkit for managing static web assets.

- **Manifest** — Structured metadata for different asset types (JS, CSS, images, fonts, etc.)
- **Compression** — Brotli, Zstandard, and gzip variant generation with configurable thresholds.
- **File Utilities** — Misc file helpers.
- **Deploy Helpers** — Assets history tracking to prevent URL collisions for immutable assets, version skew protection.

## Installation

```bash
npm install assetcraft
```

## Usage

### Manifest Types

```ts
/**
 * Asset type classification for manifest entries.
 * Each type determines how the asset is handled in the build pipeline.
 */
export type ManifestEntryType =
  | 'js'
  | 'wasm'
  | 'html'
  | 'css'
  | 'font'
  | 'image'
  | 'svg'
  | 'audio'
  | 'video'
  | 'text'
  | 'binary'
  | 'sourcemap'
  | 'compression-dictionary';

/**
 * A common set of properties for all manifest entries.
 */
export interface ManifestBaseEntry<T extends ManifestEntryType> {
  // "js" | "wasm" | "html" | "css" | "font" | "image" | "svg" | ... (see above)
  type: ManifestEntryType;
  // MIME type string, e.g. "application/javascript"
  mime: string;
  // Immutable asset; its URL will never serve different content
  immutable?: boolean;
  // Public URL to serve the asset
  url: string | { origin: string; path: string };
  // File path on disk
  path: string;
  // SHA-256 hash of the content (base64url-encoded)
  sha256: string;
  // Uncompressed size in bytes (Content-Length, budgets, diff summaries)
  size: number;
  // (optional) Logical name(s) for lookup by build tools
  name?: string | string[];
  // (optional) Arbitrary tags for filtering or grouping
  tags?: string[];
  // (optional) Extra HTTP headers to attach when serving
  headers?: Record<string, string>;
  // (optional) Subresource Integrity string, e.g. "sha384-…"
  integrity?: string;
  // (optional) Compressed variants: { br/zstd/gzip: { path, size, sha256? } }
  compressed?: ManifestCompressedVariants;
  // (optional) HTML hints: crossorigin, fetchPriority, preload
  crossorigin?: 'anonymous' | 'use-credentials';
  fetchPriority?: 'high' | 'low' | 'auto';
  // (optional) Resources to preload (rendered as `Link` headers, see `assetcraft/http`)
  preload?: ManifestPreload[]; // { url, as?, crossorigin?, fetchPriority?, media? }
}

// Per-type media metadata and HTML hints, e.g. JS module/deps,
// image dimensions/srcset, font descriptors, video duration/poster.
export interface ManifestJSEntry extends ManifestBaseEntry<'js'> {
  module?: 'esm' | 'script';
  entry?: boolean;
  async?: boolean;
  defer?: boolean;
  deps?: string[];
}
export interface ManifestImageEntry extends ManifestBaseEntry<'image'> {
  width?: number;
  height?: number;
  srcset?: ManifestImageCandidate[];
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
}
// ... ManifestSVGEntry, ManifestTextEntry, ManifestBinaryEntry, etc.

export type ManifestEntry = ManifestJSEntry | ManifestImageEntry; /* | ... */
```

Immutable assets (`immutable: true`) get a long-lived immutable `Cache-Control` directive; mutable ones must revalidate. Compressed variants are tracked per format in `entry.compressed` (`{ br/zstd/gzip: { path, size, sha256? } }`).

### Build a manifest entry

```ts
import { createManifestEntry } from 'assetcraft/manifest/entry';
import { ManifestBuilder } from 'assetcraft/manifest/build';

const builder = new ManifestBuilder(prevManifest);

// Hashes content, derives hashed names/URLs, computes SRI, optionally compresses.
const { entry, variants } = await createManifestEntry({
  type: 'js',
  mime: 'application/javascript',
  content: code,
  path: 'assets/app.js',
  name: 'app',
  compress: true,
  extra: { module: 'esm', entry: true, deps: ['/assets/dep-a1b2.js'] },
});
builder.add(entry);
// Write variants.br/.zstd/.gzip to entry.compressed.*.path
```

### Build a manifest

```ts
import { readFile } from 'node:fs/promises';
import { ManifestBuilder } from 'assetcraft/manifest/build';
import { calculateHash, uniqueFileName } from 'assetcraft/file';

const builder = new ManifestBuilder(prevManifest);

const code = await readFile('dist/app.js', 'utf8');
const hash = calculateHash(code);
builder.add({
  name: 'app',
  type: 'js',
  mime: 'application/javascript',
  immutable: true,
  url: `/assets/${uniqueFileName('app.js', hash)}`,
  path: 'pub/app.js',
  sha256: hash,
  size: Buffer.byteLength(code),
  preload: [{ url: '/assets/dep.js', as: 'script' }],
  headers: {
    'X-Content-Type-Options': 'nosniff',
  },
});
// Tip: createManifestEntry (above) does the hashing, sizing, naming,
// integrity, and compression steps for you. `preload` renders as a
// `Link` header via `responseHeadersForEntry` (see `assetcraft/http`),
// so don't hand-write `Link` in `headers`.
```

### Compress assets

```ts
import { compressAsset, compressAssetSync } from 'assetcraft/compress';

// Async (parallel): result only contains variants meeting the savings threshold.
const result = await compressAsset(content, { sizeMin: 512, sizeMinDiffRatio: 0.1 });
for (const [format, data] of Object.entries(result)) {
  // format: 'br' | 'zstd' | 'gzip', data: Buffer
}

// Sync version:
const syncResult = compressAssetSync(content);
```

### Deploy (history, plan, state)

```ts
import { Deploy } from 'assetcraft/deploy';

// Load the manifests + deploy state, throwing on immutable URL reuse
// with different content. One manifest path per build tool; previous
// manifests are read back from the deploy state, so callers never
// handle them directly.
const deploy = await Deploy.open({
  manifests: ['dist/manifest.html.json', 'dist/manifest.js.json'],
  path: 'pub/deploy.json',
});

// Plan upload/removal against the previous snapshots.
const plan = deploy.plan();
// …upload plan.add, delete plan.remove…

// Persist updated history, pending removals, and manifest snapshots
// for the next cycle.
await deploy.commit();
```

Each manifest's entry paths resolve against its own directory. Files are keyed by manifest + path, so different manifests may use the same relative path; public URLs share one global history namespace.

## License

MIT OR Apache-2.0
