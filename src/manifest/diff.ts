/**
 * Diffing for manifests. Compares two builds keyed by file path and
 * reports added, removed, changed, and unchanged entries. Useful for
 * deploy summaries, cache-invalidation decisions, and build logging.
 */

import type { Manifest, ManifestEntry } from '../manifest.js';
import { urlToString } from '../manifest.js';

/** A single entry that exists in both manifests with differences. */
export interface ManifestChangedEntry {
  /** Entry from the previous manifest. */
  prev: ManifestEntry;
  /** Entry from the next manifest. */
  next: ManifestEntry;
  /** Whether the content hash changed (false means metadata-only change). */
  hashChanged: boolean;
}

/** Result of {@link diffManifests}. */
export interface ManifestDiff {
  /** Entries present only in `next`, in manifest order. */
  added: ManifestEntry[];
  /** Entries present only in `prev`, in manifest order. */
  removed: ManifestEntry[];
  /** Entries present in both but different, in `next` order. */
  changed: ManifestChangedEntry[];
  /** Entries identical in both, in `next` order. */
  unchanged: ManifestEntry[];
}

/**
 * Compare `prev` against `next` by file path.
 * Entries with the same path but a different hash or different metadata
 * are reported as changed.
 */
export function diffManifests(prev: Manifest, next: Manifest): ManifestDiff {
  const prevByPath = new Map<string, ManifestEntry>();
  for (const entry of prev) {
    prevByPath.set(entry.path, entry);
  }
  const diff: ManifestDiff = { added: [], removed: [], changed: [], unchanged: [] };
  const seen = new Set<string>();
  for (const entry of next) {
    seen.add(entry.path);
    const old = prevByPath.get(entry.path);
    if (old === undefined) {
      diff.added.push(entry);
    } else if (isEqualManifestEntry(old, entry)) {
      diff.unchanged.push(entry);
    } else {
      diff.changed.push({ prev: old, next: entry, hashChanged: old.sha256 !== entry.sha256 });
    }
  }
  for (const entry of prev) {
    if (!seen.has(entry.path)) {
      diff.removed.push(entry);
    }
  }
  return diff;
}

/**
 * Base-entry keys compared explicitly. Every other key is type-specific
 * media metadata or hints and is compared generically, so new per-type
 * fields are covered without updating this function.
 */
const BASE_KEYS: ReadonlySet<string> = new Set([
  'type',
  'mime',
  'immutable',
  'path',
  'sha256',
  'size',
  'url',
  'name',
  'tags',
  'headers',
  'integrity',
  'compressed',
  'crossorigin',
  'fetchPriority',
  'preload',
]);

/**
 * Check whether two manifest entries carry equal metadata. A `false`
 * result is always safe (treat entries as different); it just forgoes
 * reference-stability optimizations.
 */
export function isEqualManifestEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.type !== b.type ||
    a.mime !== b.mime ||
    a.immutable !== b.immutable ||
    a.path !== b.path ||
    a.sha256 !== b.sha256 ||
    a.size !== b.size ||
    a.integrity !== b.integrity ||
    a.crossorigin !== b.crossorigin ||
    a.fetchPriority !== b.fetchPriority ||
    a.preload !== b.preload ||
    urlToString(a.url) !== urlToString(b.url) ||
    !isEqualJsonValue(a.name, b.name) ||
    !isEqualJsonValue(a.tags, b.tags) ||
    !isEqualJsonValue(a.headers, b.headers) ||
    !isEqualJsonValue(a.compressed, b.compressed)
  ) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (BASE_KEYS.has(key)) {
      continue;
    }
    if (
      !isEqualJsonValue(
        (a as unknown as Record<string, unknown>)[key],
        (b as unknown as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Compare optional JSON-like metadata (`name`, `tags`, `headers`, …). */
function isEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
