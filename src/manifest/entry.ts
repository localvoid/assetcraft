import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import type { CompressFormat } from '../compress.js';
import type {
  ManifestBaseEntry,
  ManifestCompressedVariants,
  ManifestEntry,
  ManifestEntryType,
  ManifestPreload,
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
   * When `pathHash` is enabled (default), the content hash is inserted
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
  /**
   * Insert the content hash into the file name. `true` (default) uses a
   * 12-character prefix, a number uses that prefix length, `false`
   * disables hashing.
   */
  readonly pathHash?: boolean | number;
  /** Compute an SRI string with this algorithm (default "sha384", false to skip). */
  readonly integrity?: false | IntegrityAlgorithm;
  /**
   * Compress the content and record variants in `entry.compressed`.
   * `true` uses default thresholds; an object tunes them. Default false.
   */
  readonly compress?: boolean | CompressAssetOptions;
  /** CORS mode hint for HTML tag generation. */
  readonly crossorigin?: ManifestBaseEntry<T>['crossorigin'];
  /** Fetch-priority hint for HTML tag generation. */
  readonly fetchPriority?: ManifestBaseEntry<T>['fetchPriority'];
  /** Resources to preload when serving the entry (rendered as `Link` headers). */
  readonly preload?: ManifestPreload[];
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

  const bytes = typeof content === 'string' ? TEXT_ENCODER.encode(content) : content;
  const size = bytes.length;
  const sha256 = calculateHash(bytes);

  const pathHash = options.pathHash ?? true;
  const path =
    pathHash === false
      ? options.path
      : hashedFileName(options.path, sha256, typeof pathHash === 'number' ? pathHash : 12);
  const url = options.url ?? `/${path}`;
  const integrity = options.integrity ?? 'sha384';

  const entry: Record<string, unknown> = {
    type,
    mime,
    url,
    path,
    sha256,
    size,
    ...extra,
  };
  if (options.immutable !== false) {
    entry.immutable = true;
  }
  if (name !== undefined) {
    entry.name = name;
  }
  if (tags !== undefined) {
    entry.tags = tags;
  }
  if (headers !== undefined) {
    entry.headers = headers;
  }
  if (crossorigin !== undefined) {
    entry.crossorigin = crossorigin;
  }
  if (fetchPriority !== undefined) {
    entry.fetchPriority = fetchPriority;
  }
  if (preload !== undefined) {
    entry.preload = preload;
  }
  if (integrity !== false) {
    entry.integrity = computeIntegrity(bytes, integrity);
  }

  let variants: CompressAssetResult | undefined;
  if (options.compress) {
    variants = await compressAsset(bytes, options.compress === true ? undefined : options.compress);
    const formats = Object.keys(variants) as CompressFormat[];
    if (formats.length > 0) {
      const compressed: ManifestCompressedVariants = {};
      entry.compressed = compressed;
      for (const format of formats) {
        const data = variants[format]!;
        compressed[format] = {
          path: `${path}.${format}`,
          size: data.length,
          sha256: calculateHash(data),
        };
      }
    }
  }

  return { entry: entry as unknown as ManifestEntryFor<T>, variants: variants ?? {} };
}

/** Compute an SRI string (`"<algo>-<base64>"`) for `content`. */
function computeIntegrity(content: Uint8Array, algorithm: IntegrityAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`;
}

/** Insert a hash prefix before the extension (`app.js` → `app-<hash>.js`). */
function hashedFileName(path: string, hash: string, hashLength: number): string {
  const digest = hash.slice(0, hashLength);
  const ext = extname(path);
  if (ext === '') {
    return `${path}-${digest}`;
  }
  return `${path.slice(0, -ext.length)}-${digest}${ext}`;
}

const TEXT_ENCODER = new TextEncoder();
