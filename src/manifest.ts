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
 * Base manifest entry with fields shared by all asset types.
 * @typeParam T - The specific asset type discriminant.
 */
export interface ManifestBaseEntry<T extends ManifestEntryType> {
  /** Asset type (js, css, image, etc.). */
  type: T;
  /** MIME type string (e.g. "application/javascript"). */
  mime: string;
  /** Bitfield of asset flags (immutable, compressed, etc.). */
  flags: number;
  /** Public URL used to serve the asset. */
  url: string | { origin: string; path: string };
  /** File path on disk. */
  path: string;
  /** SHA-256 hash of the asset content (base64url-encoded). */
  sha256: string;
  /** Logical name(s) for lookup by build tools. */
  name?: string | string[];
  /** Arbitrary key-value tags for filtering or grouping. */
  tags?: string[];
  /** Extra HTTP headers to attach when serving this asset. */
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
  | ManifestAudioEntry
  | ManifestVideoEntry
  | ManifestMiscEntry
  | ManifestSourceMapEntry
  | ManifestCompressionDictionaryEntry;
/** URL-keyed index of manifest entries. */
export type ManifestIndex = Record<string, ManifestEntry>;
/** A manifest is an ordered list of asset entries. */
export type Manifest = ManifestEntry[];

/** Asset is immutable; its URL will never serve different content. */
export const MANIFEST_ASSET_IMMUTABLE = 1;
/** Asset has a Brotli-compressed variant on disk. */
export const MANIFEST_ASSET_COMPRESSED_BROTLI = 1 << 1;
/** Asset has a Zstandard-compressed variant on disk. */
export const MANIFEST_ASSET_COMPRESSED_ZSTD = 1 << 2;
/** Asset has a gzip-compressed variant on disk. */
export const MANIFEST_ASSET_COMPRESSED_GZIP = 1 << 3;
/** Combined mask for any compression flag. */
export const MANIFEST_ASSET_COMPRESSED =
  MANIFEST_ASSET_COMPRESSED_BROTLI |
  MANIFEST_ASSET_COMPRESSED_ZSTD |
  MANIFEST_ASSET_COMPRESSED_GZIP;

/** Helpers section */

/**
 * Dynamically import one or more JSON manifest files.
 */
export async function importManifests(
  manifests: string[],
): Promise<{ path: string; manifest: Manifest }[]> {
  const result = [];
  for (const path of manifests) {
    const manifest = (await import(path, { with: { type: 'json' } })).default;
    result.push({ path, manifest });
  }
  return result;
}
