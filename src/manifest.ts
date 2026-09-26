/**
 * Asset type classification for manifest entries.
 * Each type determines how the asset is handled in the build pipeline.
 *
 * - `text`: UTF-8 textual data (json, txt, csv, xml, webmanifest, sitemap).
 * - `binary`: opaque bytes (pdf, zip, bin, 3d models).
 * - `svg`: vector image; text-like (compressible, inlinable) but used as an image.
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

/** A single compressed variant of an asset (Brotli, Zstandard, or gzip). */
export interface ManifestCompressedVariant {
  /** File path of the compressed variant on disk. */
  path: string;
  /** Size of the compressed variant in bytes. */
  size: number;
  /** SHA-256 hash of the compressed content (base64url-encoded). */
  sha256?: string;
}

/** Compressed variants of an asset, keyed by format (`'.' + key` is the file suffix). */
export interface ManifestCompressedVariants {
  br?: ManifestCompressedVariant;
  zst?: ManifestCompressedVariant;
  gz?: ManifestCompressedVariant;
}

/** Candidate of a responsive image (`srcset` entry). */
export interface ManifestImageCandidate {
  /**
   * Public URL of the candidate. Should match another entry's public
   * URL (see `validateManifestReferences` in `assetcraft/manifest/validate`).
   */
  url: string;
  /** Intrinsic width in pixels (for `w` descriptors). */
  width?: number;
  /** Pixel density (for `x` descriptors). */
  density?: number;
}

/**
 * A single resource to preload when serving the entry. Renders as one
 * `Link: <url>; rel=preload; …` header value (see `getPreloadLink` in
 * `assetcraft/http`).
 */
export interface ManifestPreload {
  /**
   * Public URL of the preloaded resource. Should match another entry's
   * public URL (see `validateManifestReferences` in `assetcraft/manifest/validate`).
   */
  url: string;
  /** Link `as` value (e.g. `"script"`, `"style"`, `"image"`, `"font"`). */
  as?: string;
  /** CORS mode for the preload request. */
  crossorigin?: 'anonymous' | 'use-credentials';
  /** Fetch-priority hint for the preload request. */
  fetchPriority?: 'high' | 'low' | 'auto';
  /** Media query restricting when the preload applies. */
  media?: string;
}

/**
 * Base manifest entry with fields shared by all asset types.
 * @typeParam T - The specific asset type discriminant.
 */
export interface ManifestBaseEntry<T extends ManifestEntryType> {
  /** Asset type (js, css, image, etc.). */
  type: T;
  /** MIME type string (e.g. "application/javascript"). */
  mime: string;
  /** Immutable asset; its URL will never serve different content. */
  immutable?: boolean;
  /** Public URL used to serve the asset. */
  url: string | { origin: string; path: string };
  /** File path on disk. */
  path: string;
  /** SHA-256 hash of the asset content (base64url-encoded). */
  sha256: string;
  /** Uncompressed size of the asset in bytes. */
  size: number;
  /** Logical name(s) for lookup by build tools. */
  name?: string | string[];
  /** Arbitrary key-value tags for filtering or grouping. */
  tags?: string[];
  /** Extra HTTP headers to attach when serving this asset. */
  headers?: Record<string, string>;
  /** Subresource Integrity string (e.g. "sha384-…") for HTML tag generation. */
  integrity?: string;
  /**
   * Compression intent for the deploy script. `true` always tries
   * compression, `false` never compresses, `undefined` (default) defers
   * to the deploy script's filter or the `isCompressible` type/mime
   * default in `assetcraft/compress`.
   */
  compressible?: boolean;
  /** Compressed variants of the asset on disk. */
  compressed?: ManifestCompressedVariants;
  /** CORS mode for `<script crossorigin>` / `<link crossorigin>` generation. */
  crossorigin?: 'anonymous' | 'use-credentials';
  /** Fetch-priority hint for `<script fetchpriority>` / `<link fetchpriority>`. */
  fetchPriority?: 'high' | 'low' | 'auto';
  /**
   * Resources to preload when serving this entry, in order. Each renders
   * as one `Link: <url>; rel=preload; …` header value (see
   * `getPreloadLink` / `buildResponseHeaders` in `assetcraft/http`).
   */
  preload?: ManifestPreload[];
  /**
   /**
   * Output-relative path of the external debug information for this
   * asset (a source map for JS/CSS/WASM, a symbol file for native
   * binaries, …). Must match another entry's `path` (see
   * `validateManifestReferences` in `assetcraft/manifest/validate`).
   */
  symbols?: string;
}

export interface ManifestJSEntry extends ManifestBaseEntry<'js'> {
  /** Module format hint for `<script type="module">` generation. */
  module?: 'esm' | 'script';
  /** Entry point of the application (emits preload hints for `deps`). */
  entry?: boolean;
  /** Emit `<script async>`. */
  async?: boolean;
  /** Emit `<script defer>`. */
  defer?: boolean;
  /**
   * Public URLs of dependencies to preload (consumed as modulepreload
   * `Link` headers). Each should match another entry's public URL (see
   * `validateManifestReferences` in `assetcraft/manifest/validate`).
   */
  deps?: string[];
}
export interface ManifestWASMEntry extends ManifestBaseEntry<'wasm'> {
  /** Entry point module instantiated by the application. */
  entry?: boolean;
}
export interface ManifestHTMLEntry extends ManifestBaseEntry<'html'> {
  /** Page title for `<title>` generation. */
  title?: string;
  /** Language of the document (`<html lang>`). */
  lang?: string;
  /** Entry page of the application. */
  isEntry?: boolean;
  /** Served as SPA fallback for unknown routes. */
  isFallback?: boolean;
}
export interface ManifestCSSEntry extends ManifestBaseEntry<'css'> {
  /** Media query for `<link media>` generation. */
  media?: string;
  /** Entry stylesheet of the application. */
  entry?: boolean;
}
export interface ManifestFontEntry extends ManifestBaseEntry<'font'> {
  /** Font family for `@font-face` generation. */
  family?: string;
  /** Font weight for `@font-face` generation. */
  weight?: string;
  /** Font style for `@font-face` generation. */
  style?: string;
  /** Font display strategy for `@font-face` generation. */
  display?: string;
  /** Font stretch for `@font-face` generation. */
  stretch?: string;
  /** Unicode range for `@font-face` generation. */
  unicodeRange?: string;
}
export interface ManifestImageEntry extends ManifestBaseEntry<'image'> {
  /** Intrinsic width in pixels. */
  width?: number;
  /** Intrinsic height in pixels. */
  height?: number;
  /** Responsive candidates for `srcset` generation. */
  srcset?: ManifestImageCandidate[];
  /** Loading hint for `<img loading>` generation. */
  loading?: 'lazy' | 'eager';
  /** Decoding hint for `<img decoding>` generation. */
  decoding?: 'async' | 'sync' | 'auto';
}
export interface ManifestSVGEntry extends ManifestBaseEntry<'svg'> {
  /** Intrinsic width in pixels. */
  width?: number;
  /** Intrinsic height in pixels. */
  height?: number;
  /** Hint that the asset may be inlined into HTML. */
  inline?: boolean;
}
export interface ManifestAudioEntry extends ManifestBaseEntry<'audio'> {
  /** Duration in seconds. */
  duration?: number;
}
export interface ManifestVideoEntry extends ManifestBaseEntry<'video'> {
  /** Intrinsic width in pixels. */
  width?: number;
  /** Intrinsic height in pixels. */
  height?: number;
  /** Duration in seconds. */
  duration?: number;
  /**
   * Public URL of the poster image for `<video poster>` generation.
   * Should match another entry's public URL (see
   * `validateManifestReferences` in `assetcraft/manifest/validate`).
   */
  poster?: string;
}
export interface ManifestTextEntry extends ManifestBaseEntry<'text'> {
  /** Character set of the asset (default "utf-8"). */
  charset?: string;
}
export interface ManifestBinaryEntry extends ManifestBaseEntry<'binary'> {}
export interface ManifestSourceMapEntry extends ManifestBaseEntry<'sourcemap'> {
  /**
   * Output-relative path of the asset this source map describes. Must
   * match another entry's `path` (see `validateManifestReferences` in
   * `assetcraft/manifest/validate`).
   */
  source?: string;
}

/** Compression-dictionary entry used for Brotli/DC web-ready compression hints. */
export interface ManifestCompressionDictionaryEntry extends ManifestBaseEntry<'compression-dictionary'> {
  /** Substring match pattern for the dictionary. */
  match: string;
  /** Optional destination URL for the compressed variant. */
  matchDest?: string;
}

/** Union of all concrete manifest entry types. */
export type ManifestEntry =
  | ManifestJSEntry
  | ManifestWASMEntry
  | ManifestHTMLEntry
  | ManifestCSSEntry
  | ManifestFontEntry
  | ManifestImageEntry
  | ManifestSVGEntry
  | ManifestAudioEntry
  | ManifestVideoEntry
  | ManifestTextEntry
  | ManifestBinaryEntry
  | ManifestSourceMapEntry
  | ManifestCompressionDictionaryEntry;
/** URL-keyed index of manifest entries. */
export type ManifestIndex = Record<string, ManifestEntry>;
/** A manifest is an ordered list of asset entries. */
export type Manifest = readonly ManifestEntry[];

/** Version of the manifest file format written by this library. */
export const MANIFEST_VERSION = 1;

/**
 * Manifest file envelope: versioned wrapper around an ordered entry
 * list. Files on disk always use this shape; in-memory pipelines keep
 * working on the bare {@link Manifest} entry list (`envelope.entries`).
 */
export interface ManifestEnvelope {
  /** File format version (currently the only supported version). */
  version: typeof MANIFEST_VERSION;
  /** Asset entries, in order. */
  entries: Manifest;
}

/** Helpers section */

/**
 * Normalize a manifest public URL to string form. Object URLs
 * (`{ origin, path }`) are scoped by origin, so `origin + path` is a
 * collision-safe key.
 */
export function urlToString(url: ManifestEntry['url']): string {
  return typeof url === 'string' ? url : url.origin + url.path;
}

/**
 * Dynamically import one or more JSON manifest files. Each file must
 * hold a {@link ManifestEnvelope}.
 */
export async function importManifests(
  manifests: string[],
): Promise<{ path: string; manifest: ManifestEnvelope }[]> {
  const result = [];
  for (const path of manifests) {
    const manifest = (await import(path, { with: { type: 'json' } })).default;
    result.push({ path, manifest });
  }
  return result;
}
