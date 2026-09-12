/**
 * HTTP serving helpers for static assets: cache directives, content
 * encodings for compressed variants, preload `Link` headers, and response
 * header assembly.
 */

import type { CompressFormat } from './compress.js';
import type { ManifestEntry, ManifestEntryType, ManifestPreload } from './manifest.js';

/** HTTP `Content-Encoding` value for a {@link CompressFormat}. */
export type CompressContentEncoding = 'br' | 'zstd' | 'gzip';

/** Map a compression format key to its HTTP `Content-Encoding` value. */
export function getContentEncoding(format: CompressFormat): CompressContentEncoding {
  switch (format) {
    case 'zst':
      return 'zstd';
    case 'gz':
      return 'gzip';
    default:
      return 'br';
  }
}

/** Options for {@link getCacheControl}. */
export interface CacheControlOptions {
  /** max-age for immutable assets (default 31536000 = 1 year). */
  readonly immutableMaxAge?: number;
  /** max-age for mutable assets, paired with must-revalidate (default 0). */
  readonly mutableMaxAge?: number;
}

/**
 * Build a `Cache-Control` value for an entry. Immutable assets get a
 * long-lived immutable directive; mutable ones must revalidate.
 */
export function getCacheControl(
  entry: Pick<ManifestEntry, 'immutable'>,
  options?: CacheControlOptions,
): string {
  if (entry.immutable === true) {
    return `public, max-age=${options?.immutableMaxAge ?? 31536000}, immutable`;
  }
  return `public, max-age=${options?.mutableMaxAge ?? 0}, must-revalidate`;
}

/**
 * Build an `ETag` value for an entry from its content hash.
 * Quoted so it can be compared against `If-None-Match` directly.
 */
export function getETag(entry: Pick<ManifestEntry, 'sha256'>): string {
  return `"${entry.sha256}"`;
}

/** Options for {@link buildResponseHeaders}. */
export interface ResponseHeadersOptions {
  /** Cache-Control header. Default: true */
  readonly cacheControl?: boolean;
  /** Content-Length header from `entry.size`. Default: true */
  readonly contentLength?: boolean;
  /** ETag header from `entry.sha256`. Default: true */
  readonly etag?: boolean;
  /** `Link` header from `entry.preload`. Default: true */
  readonly link?: boolean;
  /** Compression format of the variant being served (mapped to Content-Encoding + Vary). */
  readonly encoding?: CompressFormat;
  /**
   * Size of the variant being served. Used for Content-Length when
   * `encoding` selects a compressed variant tracked in
   * `entry.compressed`; defaults to the variant's recorded size.
   */
  readonly variantSize?: number;
}

/**
 * Resolve a `Link` preload `as` value from a manifest entry type.
 * Returns `undefined` for types with no meaningful mapping
 * (`sourcemap`, `compression-dictionary`).
 */
export function getPreloadAs(type: ManifestEntryType): string | undefined {
  switch (type) {
    case 'js':
      return 'script';
    case 'css':
      return 'style';
    case 'font':
      return 'font';
    case 'image':
    case 'svg':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'html':
      return 'document';
    case 'wasm':
    case 'text':
    case 'binary':
      return 'fetch';
    default:
      return undefined;
  }
}

/** Per-resource `Link` params for {@link getPreloadLink}. */
export type PreloadLinkOptions = Pick<
  ManifestPreload,
  'as' | 'crossorigin' | 'fetchPriority' | 'media'
>;

/** Quotes a `Link` `media` parameter when it contains delimiters/whitespace. */
function quoteLinkMedia(media: string): string {
  if (/[\s;,"]/.test(media)) {
    return `"${media.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return media;
}

/**
 * Format one `Link` header value for a preloaded URL.
 * `options.as` wins; otherwise `as` is resolved from `type` (if given).
 * `crossorigin` defaults to `anonymous` for fonts.
 */
export function getPreloadLink(
  target: string,
  options?: PreloadLinkOptions,
  type?: ManifestEntryType,
): string {
  const as = options?.as ?? (type !== undefined ? getPreloadAs(type) : undefined);
  const crossorigin = options?.crossorigin ?? (as === 'font' ? 'anonymous' : undefined);
  let link = `<${target}>; rel=preload`;
  if (as !== undefined) {
    link += `; as=${as}`;
  }
  if (crossorigin !== undefined) {
    link += `; crossorigin=${crossorigin}`;
  }
  if (options?.fetchPriority !== undefined) {
    link += `; fetchpriority=${options.fetchPriority}`;
  }
  if (options?.media !== undefined) {
    link += `; media=${quoteLinkMedia(options.media)}`;
  }
  return link;
}

/**
 * Format the `Link` header value for a list of preloads (joined with
 * `', '`). Returns `undefined` when there is nothing to preload.
 */
export function getLinkHeader(
  preloads: readonly ManifestPreload[] | undefined,
): string | undefined {
  if (preloads === undefined || preloads.length === 0) {
    return undefined;
  }
  return preloads.map((preload) => getPreloadLink(preload.url, preload)).join(', ');
}

/**
 * Assemble response headers for an entry: Content-Type from MIME,
 * Cache-Control from the immutable hint, Content-Length from size, ETag from the
 * content hash, Content-Encoding/Vary for compressed variants, and `Link`
 * from `entry.preload` (generated links come first; an existing user `Link`
 * in `entry.headers` is appended with `, `).
 * `entry.headers` are merged last and take precedence.
 */
export function buildResponseHeaders(
  entry: ManifestEntry,
  options?: ResponseHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': entry.mime,
  };
  if (options?.cacheControl !== false) {
    headers['Cache-Control'] = getCacheControl(entry);
  }
  if (options?.contentLength !== false) {
    headers['Content-Length'] = String(variantSizeFor(entry, options));
  }
  if (options?.etag !== false) {
    headers['ETag'] = getETag(entry);
  }
  if (options?.encoding !== undefined) {
    headers['Content-Encoding'] = getContentEncoding(options.encoding);
    headers['Vary'] = 'Accept-Encoding';
  }
  const preloadLink = options?.link === false ? undefined : getLinkHeader(entry.preload);
  if (entry.headers !== undefined) {
    for (const [k, v] of Object.entries(entry.headers)) {
      if (k === 'Link' && preloadLink !== undefined) {
        headers[k] = `${preloadLink}, ${v}`;
      } else {
        headers[k] = v;
      }
    }
  }
  if (preloadLink !== undefined && headers['Link'] === undefined) {
    headers['Link'] = preloadLink;
  }
  return headers;
}

/** Resolve the byte size to advertise for the served variant. */
function variantSizeFor(entry: ManifestEntry, options?: ResponseHeadersOptions): number {
  if (options?.variantSize !== undefined) {
    return options.variantSize;
  }
  if (options?.encoding !== undefined) {
    const variant = entry.compressed?.[options.encoding];
    if (variant !== undefined) {
      return variant.size;
    }
  }
  return entry.size;
}
