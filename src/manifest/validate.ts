/**
 * Validation for manifest entries loaded from outside the build pipeline
 * (JSON files, external manifests, previous-build artifacts).
 */

import type { Manifest, ManifestEntry, ManifestEntryType } from '../manifest.js';

/** All known manifest entry type discriminants. */
const ENTRY_TYPES: ReadonlySet<string> = new Set<string>([
  'js',
  'wasm',
  'html',
  'css',
  'font',
  'image',
  'audio',
  'video',
  'misc',
  'sourcemap',
  'compression-dictionary',
]);

/** Base64url alphabet (no padding) used for content hashes. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a single manifest entry. Returns a list of human-readable
 * problems; an empty array means the entry is valid.
 */
export function validateManifestEntry(entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null) {
    return ['entry must be an object'];
  }
  const e = entry as Record<string, unknown>;

  if (typeof e['type'] !== 'string' || !ENTRY_TYPES.has(e['type'])) {
    errors.push(`type must be one of ${[...ENTRY_TYPES].join(', ')}`);
  }
  if (typeof e['mime'] !== 'string' || e['mime'] === '') {
    errors.push('mime must be a non-empty string');
  }
  if (typeof e['flags'] !== 'number' || !Number.isInteger(e['flags']) || e['flags'] < 0) {
    errors.push('flags must be a non-negative integer');
  }
  const url = e['url'];
  if (typeof url === 'string') {
    if (url === '') {
      errors.push('url must be a non-empty string');
    }
  } else if (typeof url === 'object' && url !== null) {
    const u = url as Record<string, unknown>;
    if (typeof u['origin'] !== 'string' || typeof u['path'] !== 'string') {
      errors.push('url object must have string origin and path');
    }
  } else {
    errors.push('url must be a string or { origin, path }');
  }
  if (typeof e['path'] !== 'string' || e['path'] === '') {
    errors.push('path must be a non-empty string');
  }
  if (
    typeof e['sha256'] !== 'string' ||
    e['sha256'] === '' ||
    !BASE64URL_RE.test(e['sha256'] as string)
  ) {
    errors.push('sha256 must be a base64url-encoded string');
  }
  if (e['name'] !== undefined) {
    const name = e['name'];
    const names = typeof name === 'string' ? [name] : name;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((n) => typeof n !== 'string' || n === '')
    ) {
      errors.push('name must be a non-empty string or an array of non-empty strings');
    }
  }
  if (
    e['tags'] !== undefined &&
    (!Array.isArray(e['tags']) || e['tags'].some((t) => typeof t !== 'string'))
  ) {
    errors.push('tags must be an array of strings');
  }
  if (e['headers'] !== undefined) {
    const headers = e['headers'];
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers) ||
      Object.values(headers).some((v) => typeof v !== 'string')
    ) {
      errors.push('headers must be a record of string to string');
    }
  }
  if (e['type'] === 'compression-dictionary') {
    if (typeof e['match'] !== 'string' || e['match'] === '') {
      errors.push('match must be a non-empty string for compression-dictionary entries');
    }
    if (e['matchDest'] !== undefined && typeof e['matchDest'] !== 'string') {
      errors.push('matchDest must be a string for compression-dictionary entries');
    }
  }
  return errors;
}

/**
 * Assert that `entry` is a valid manifest entry.
 * @throws If validation fails, with all problems listed in the message.
 */
export function assertManifestEntry(entry: unknown): asserts entry is ManifestEntry {
  const errors = validateManifestEntry(entry);
  if (errors.length > 0) {
    throw Error(`Invalid manifest entry: ${errors.join('; ')}`);
  }
}

/**
 * Validate a manifest (an array of entries). Returns problems prefixed
 * with the offending entry index; an empty array means the manifest
 * is valid.
 */
export function validateManifest(manifest: unknown): string[] {
  if (!Array.isArray(manifest)) {
    return ['manifest must be an array'];
  }
  const errors: string[] = [];
  for (let i = 0; i < manifest.length; i++) {
    for (const problem of validateManifestEntry(manifest[i])) {
      errors.push(`[${i}] ${problem}`);
    }
  }
  return errors;
}

/**
 * Parse a manifest from a JSON string.
 * @throws On invalid JSON, non-array payloads, or invalid entries.
 */
export function parseManifest(data: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw Error(`Invalid manifest JSON: ${(error as Error).message}`);
  }
  const errors = validateManifest(parsed);
  if (errors.length > 0) {
    throw Error(`Invalid manifest: ${errors.join('; ')}`);
  }
  return parsed as Manifest;
}

/** Check whether `type` is a known manifest entry type discriminant. */
export function isManifestEntryType(type: unknown): type is ManifestEntryType {
  return typeof type === 'string' && ENTRY_TYPES.has(type);
}
