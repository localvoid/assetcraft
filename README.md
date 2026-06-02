# assetcraft

TypeScript toolkit for managing static web assets.

- **Manifest** — Structured metadata for different asset types (JS, CSS, images, fonts, etc.)
- **Assets History** — Prevents URL collisions across builds for immutable assets.
- **Compression** — Brotli, Zstandard, and gzip variant generation with configurable thresholds.
- **File Utilities** — Misc file helpers.

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
  | 'audio'
  | 'video'
  | 'misc'
  | 'sourcemap'
  | 'compression-dictionary';

/**
 * A common set of properties for all manifest entries.
 */
export interface ManifestBaseEntry<T extends ManifestEntryType> {
  // "js" | "wasm" | "html" | "css" | "font" | "image" | "audio" | "video" | "misc" | "sourcemap" | "compression-dictionary"
  type: ManifestEntryType;
  // MIME type string, e.g. "application/javascript"
  mime: string;
  // Bitfield: MANIFEST_ASSET_IMMUTABLE | MANIFEST_ASSET_COMPRESSED_BROTLI | ...
  flags: number;
  // Public URL to serve the asset
  url: string | { origin: string; path: string };
  // Filename on disk after content hashing
  fileName: string;
  // SHA-256 hash of the content (base64url-encoded)
  sha256: string;
  // (optional) Logical name(s) for lookup by build tools
  name?: string | string[];
  // (optional) Arbitrary tags for filtering or grouping
  tags?: string[];
  // (optional) Extra HTTP headers to attach when serving
  headers?: Record<string, string>;
}

export interface ManifestJSEntry extends ManifestBaseEntry<'js'> {}
export interface ManifestWASMEntry extends ManifestBaseEntry<'wasm'> {}
export interface ManifestHTMLEntry extends ManifestBaseEntry<'html'> {}
export interface ManifestCSSEntry extends ManifestBaseEntry<'css'> {}
export interface ManifestFontEntry extends ManifestBaseEntry<'font'> {}
export interface ManifestImageEntry extends ManifestBaseEntry<'image'> {}
export interface ManifestAudioEntry extends ManifestBaseEntry<'audio'> {}
export interface ManifestVideoEntry extends ManifestBaseEntry<'video'> {}
export interface ManifestMiscEntry extends ManifestBaseEntry<'misc'> {}
export interface ManifestSourceMapEntry extends ManifestBaseEntry<'sourcemap'> {}
interface ManifestCompressionDictionaryEntry extends ManifestBaseEntry<'compression-dictionary'> {
  // Substring match pattern for the dictionary
  match: string;
  // (optional) Destination URL for the compressed variant
  matchDest?: string;
}

export type ManifestEntry = ManifestJSEntry | ManifestWASMEntry /* | ... */;
```

**Flags**:

```ts
const MANIFEST_ASSET_IMMUTABLE = 1; // URL will never serve different content
const MANIFEST_ASSET_COMPRESSED_BROTLI = 2; // Brotli-compressed variant on disk
const MANIFEST_ASSET_COMPRESSED_ZSTD = 4; // Zstandard-compressed variant on disk
const MANIFEST_ASSET_COMPRESSED_GZIP = 8; // gzip-compressed variant on disk
```

### Build a manifest

```ts
import { readFile } from 'node:fs/promises';
import { ManifestBuilder } from 'assetcraft/manifest/build';
import { calculateHash, uniqueFileName } from 'assetcraft/file';
import { MANIFEST_ASSET_IMMUTABLE } from 'assetcraft/manifest';

const builder = new ManifestBuilder(prevManifest, prevHistory);

const code = await readFile('dist/app.js', 'utf8');
const hash = calculateHash(code);
builder.add({
  name: 'app',
  type: 'js',
  mime: 'application/javascript',
  flags: MANIFEST_ASSET_IMMUTABLE,
  url: `/assets/${uniqueFileName('app.js', hash)}`,
  fileName: 'pub/app.js',
  sha256: hash,
  headers: {
    Link: '</assets/dep.js>; rel=modulepreload',
  },
});
```

### Compress assets

```ts
import { compressAsset } from 'assetcraft/compress';

for (const variant of compressAsset(content, { sizeMin: 512, sizeMinDiffRatio: 0.1 })) {
  // variant.format: 'brotli' | 'zstd' | 'gzip'
  // variant.content: Buffer
}
```

### Track immutable asset URLs

```ts
import { AssetsHistory } from 'assetcraft/history';

const history = AssetsHistory.fromString(persisted);
history.add(url, sha256);
history.purge();
await writeFile('history.json', history.serialize());
```

## License

MIT OR Apache-2.0
