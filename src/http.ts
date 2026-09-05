/**
 * HTTP serving helpers for static assets: cache directives, content
 * encodings for compressed variants, and response header assembly.
 */

import type { CompressFormat } from './compress.js';
import type { ManifestEntry } from './manifest.js';

/** Options for {@link cacheControlForEntry}. */
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
export function cacheControlForEntry(
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
export function etagForEntry(entry: Pick<ManifestEntry, 'sha256'>): string {
  return `"${entry.sha256}"`;
}

/** Options for {@link responseHeadersForEntry}. */
export interface ResponseHeadersOptions {
  /** Cache-Control header. Default: true */
  readonly cacheControl?: boolean;
  /** Content-Length header from `entry.size`. Default: true */
  readonly contentLength?: boolean;
  /** ETag header from `entry.sha256`. Default: true */
  readonly etag?: boolean;
  /** Compression format of the variant being served (adds Content-Encoding + Vary). */
  readonly encoding?: CompressFormat;
  /**
   * Size of the variant being served. Used for Content-Length when
   * `encoding` selects a compressed variant tracked in
   * `entry.compressed`; defaults to the variant's recorded size.
   */
  readonly variantSize?: number;
}

/**
 * Assemble response headers for an entry: Content-Type from MIME,
 * Cache-Control from the immutable hint, Content-Length from size, ETag from the
 * content hash, Content-Encoding/Vary for compressed variants.
 * `entry.headers` are merged last and take precedence.
 */
export function responseHeadersForEntry(
  entry: ManifestEntry,
  options?: ResponseHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': entry.mime,
  };
  if (options?.cacheControl !== false) {
    headers['Cache-Control'] = cacheControlForEntry(entry);
  }
  if (options?.contentLength !== false) {
    headers['Content-Length'] = String(variantSizeFor(entry, options));
  }
  if (options?.etag !== false) {
    headers['ETag'] = etagForEntry(entry);
  }
  if (options?.encoding !== undefined) {
    headers['Content-Encoding'] = options.encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  if (entry.headers !== undefined) {
    for (const [k, v] of Object.entries(entry.headers)) {
      headers[k] = v;
    }
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
