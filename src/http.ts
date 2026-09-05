/**
 * HTTP serving helpers for static assets: cache directives, content
 * encodings for compressed variants, and response header assembly.
 */

import type { CompressFormat } from './compress.js';
import type { ManifestEntry } from './manifest.js';
import { MANIFEST_ASSET_IMMUTABLE } from './manifest.js';

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
  entry: Pick<ManifestEntry, 'flags'>,
  options?: CacheControlOptions,
): string {
  if (entry.flags & MANIFEST_ASSET_IMMUTABLE) {
    return `public, max-age=${options?.immutableMaxAge ?? 31536000}, immutable`;
  }
  return `public, max-age=${options?.mutableMaxAge ?? 0}, must-revalidate`;
}

/** Options for {@link responseHeadersForEntry}. */
export interface ResponseHeadersOptions {
  /** Cache-Control header. Default: true */
  readonly cacheControl?: boolean;
  /** Compression format of the variant being served (adds Content-Encoding + Vary). */
  readonly encoding?: CompressFormat;
}

/**
 * Assemble response headers for an entry: Content-Type from MIME,
 * Cache-Control from flags, Content-Encoding/Vary for compressed
 * variants. `entry.headers` are merged last and take precedence.
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
