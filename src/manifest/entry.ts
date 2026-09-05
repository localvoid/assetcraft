/**
 * One-shot helper for building manifest entries: hashes content, derives
 * content-hashed file names, computes Subresource Integrity, and
 * optionally compresses the asset, filling `size`, `sha256`, and
 * `compressed` metadata. Pair with `ManifestBuilder.add()`:
 *
 * ```ts
 * const { entry, variants } = await createManifestEntry({
 *   type: 'js',
 *   mime: 'application/javascript',
 *   content: code,
 *   path: 'assets/app.js',
 *   compress: true,
 *   extra: { module: 'esm', entry: true },
 * });
 * builder.add(entry);
 * // write variants.br/.zstd/.gzip to entry.compressed.*.path
 * ```
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import type { CompressFormat } from '../compress.js';
import type {
  ManifestBaseEntry,
  ManifestCompressedVariants,
  ManifestEntry,
  ManifestEntryType,
} from '../manifest.js';
import { compressAsset, type CompressAssetOptions, type CompressAssetResult } from '../compress.js';
import { calculateHash } from '../file.js';

/** Hash algorithm for the Subresource Integrity string. */
export type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512';

/** Concrete entry type for a discriminant (used to type `extra`). */
export type ManifestEntryFor<T extends ManifestEntryType> = Extract<ManifestEntry, { type: T }>;

/** Base keys managed by the helper itself or its top-level options. */
type ManagedKeys =
  | 'type'
  | 'mime'
  | 'immutable'
  | 'url'
  | 'path'
  | 'sha256'
  | 'size'
  | 'name'
  | 'tags'
  | 'headers'
  | 'integrity'
  | 'compressed'
  | 'crossorigin'
  | 'fetchPriority'
  | 'preload';

/** Filename suffix per compression format for on-disk variants. */
export interface CompressSuffixes {
  readonly br?: string;
  readonly zstd?: string;
  readonly gzip?: string;
}

const DEFAULT_SUFFIXES: Required<CompressSuffixes> = {
  br: '.br',
  zstd: '.zst',
  gzip: '.gz',
};

/** Options for {@link createManifestEntry}. */
export interface CreateManifestEntryOptions<T extends ManifestEntryType = ManifestEntryType> {
  /** Asset type discriminant. */
  readonly type: T;
  /** MIME type string (e.g. "application/javascript"). */
  readonly mime: string;
  /** Asset content; hashed, measured, and optionally compressed. */
  readonly content: string | Uint8Array;
  /**
   * Output-relative path before hashing (e.g. "assets/app.js").
   * When `hashed` is enabled (default), the content hash is inserted
   * before the extension (e.g. "assets/app-a1b2c3.js").
   */
  readonly path: string;
  /**
   * Public URL. Defaults to `"/" + ` final path. Pass an explicit value
   * when the URL scheme differs from the file layout (e.g. CDN origin).
   */
  readonly url?: string | { origin: string; path: string };
  /** Logical name(s) for lookup by build tools. */
  readonly name?: ManifestBaseEntry<T>['name'];
  /** Arbitrary tags for filtering or grouping. */
  readonly tags?: string[];
  /** Extra HTTP headers to attach when serving this asset. */
  readonly headers?: Record<string, string>;
  /** Mark the entry immutable (default true). */
  readonly immutable?: boolean;
  /** Insert the content hash into the file name (default true). */
  readonly hashed?: boolean;
  /** Hash prefix length for hashed names (default 12). */
  readonly hashLength?: number;
  /** Compute an SRI string with this algorithm (default "sha384", false to skip). */
  readonly integrity?: false | IntegrityAlgorithm;
  /**
   * Compress the content and record variants in `entry.compressed`.
   * `true` uses default thresholds; an object tunes them. Default false.
   */
  readonly compress?: boolean | CompressAssetOptions;
  /** Filename suffixes for compressed variants. */
  readonly compressSuffixes?: CompressSuffixes;
  /** CORS mode hint for HTML tag generation. */
  readonly crossorigin?: ManifestBaseEntry<T>['crossorigin'];
  /** Fetch-priority hint for HTML tag generation. */
  readonly fetchPriority?: ManifestBaseEntry<T>['fetchPriority'];
  /** Hint that the asset should be preloaded. */
  readonly preload?: boolean;
  /**
   * Type-specific media metadata and hints (dimensions, font
   * descriptors, `module`, `deps`, …). `match` is required here for
   * `compression-dictionary` entries.
   */
  readonly extra?: Omit<ManifestEntryFor<T>, ManagedKeys>;
}

/** Result of {@link createManifestEntry}. */
export interface CreateManifestEntryResult<T extends ManifestEntryType = ManifestEntryType> {
  /** The manifest entry, ready for `ManifestBuilder.add()`. */
  readonly entry: ManifestEntryFor<T>;
  /**
   * Compressed variant buffers that met the savings threshold, keyed by
   * format. Write each buffer to its `entry.compressed[format].path`.
   */
  readonly variants: CompressAssetResult;
}

/**
 * Build a manifest entry from in-memory content: measures `size`,
 * hashes `sha256`, derives hashed file names and URLs, computes
 * `integrity`, and optionally compresses the asset.
 */
export async function createManifestEntry<T extends ManifestEntryType>(
  options: CreateManifestEntryOptions<T>,
): Promise<CreateManifestEntryResult<T>> {
  const { type, mime, content, name, tags, headers, crossorigin, fetchPriority, preload, extra } =
    options;

  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  const size = bytes.length;
  const sha256 = calculateHash(bytes);

  const hashLength = options.hashLength ?? 12;
  const finalPath =
    options.hashed === false ? options.path : hashedFileName(options.path, sha256, hashLength);
  const url = options.url ?? `/${finalPath}`;

  const entry: Record<string, unknown> = {
    type,
    mime,
    url,
    path: finalPath,
    sha256,
    size,
    ...extra,
  };
  if (options.immutable !== false) {
    entry['immutable'] = true;
  }
  if (name !== undefined) {
    entry['name'] = name;
  }
  if (tags !== undefined) {
    entry['tags'] = tags;
  }
  if (headers !== undefined) {
    entry['headers'] = headers;
  }
  if (crossorigin !== undefined) {
    entry['crossorigin'] = crossorigin;
  }
  if (fetchPriority !== undefined) {
    entry['fetchPriority'] = fetchPriority;
  }
  if (preload !== undefined) {
    entry['preload'] = preload;
  }

  const integrity = options.integrity ?? 'sha384';
  if (integrity !== false) {
    entry['integrity'] = computeIntegrity(bytes, integrity);
  }

  let variants: CompressAssetResult = {};
  if (options.compress !== undefined && options.compress !== false) {
    const compressOptions = options.compress === true ? undefined : options.compress;
    variants = await compressAsset(bytes, compressOptions);
    const suffixes = { ...DEFAULT_SUFFIXES, ...options.compressSuffixes };
    if (Object.keys(variants).length > 0) {
      const compressed: ManifestCompressedVariants = {};
      for (const format of Object.keys(variants) as CompressFormat[]) {
        const data = variants[format];
        if (data === undefined) {
          continue;
        }
        compressed[format] = {
          path: finalPath + suffixes[format],
          size: data.length,
          sha256: calculateHash(data),
        };
      }
      entry['compressed'] = compressed;
    }
  }

  return { entry: entry as unknown as ManifestEntryFor<T>, variants };
}

/** Compute an SRI string (`"<algo>-<base64>"`) for `content`. */
function computeIntegrity(content: Uint8Array, algorithm: IntegrityAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`;
}

/** Insert a hash prefix before the extension (`app.js` → `app-<hash>.js`). */
function hashedFileName(path: string, hash: string, hashLength: number): string {
  const digest = hash.slice(0, Math.max(1, hashLength));
  const ext = extname(path);
  if (ext === '') {
    return `${path}-${digest}`;
  }
  return `${path.slice(0, -ext.length)}-${digest}${ext}`;
}
