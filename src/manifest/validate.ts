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
  'svg',
  'audio',
  'video',
  'text',
  'binary',
  'sourcemap',
  'compression-dictionary',
]);

/** Base64url alphabet (no padding) used for content hashes. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Subresource Integrity value (`sha256-…`, `sha384-…`, or `sha512-…`). */
const INTEGRITY_RE = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Known compression-variant keys of `compressed`. */
const COMPRESSED_FORMATS: ReadonlySet<string> = new Set(['br', 'zst', 'gz']);

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
  if (e['immutable'] !== undefined && typeof e['immutable'] !== 'boolean') {
    errors.push('immutable must be a boolean');
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
  if (typeof e['size'] !== 'number' || !Number.isInteger(e['size']) || e['size'] < 0) {
    errors.push('size must be a non-negative integer');
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
  if (e['integrity'] !== undefined) {
    if (typeof e['integrity'] !== 'string' || !INTEGRITY_RE.test(e['integrity'])) {
      errors.push('integrity must be an SRI string (e.g. "sha384-…")');
    }
  }
  if (e['compressed'] !== undefined) {
    errors.push(...validateCompressed(e['compressed']));
  }
  if (
    e['crossorigin'] !== undefined &&
    e['crossorigin'] !== 'anonymous' &&
    e['crossorigin'] !== 'use-credentials'
  ) {
    errors.push('crossorigin must be "anonymous" or "use-credentials"');
  }
  if (
    e['fetchPriority'] !== undefined &&
    e['fetchPriority'] !== 'high' &&
    e['fetchPriority'] !== 'low' &&
    e['fetchPriority'] !== 'auto'
  ) {
    errors.push('fetchPriority must be "high", "low", or "auto"');
  }
  if (e['preload'] !== undefined) {
    errors.push(...validatePreloads(e['preload']));
  }
  errors.push(...validateTypeMeta(e));
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

/** Validate the `preload` list of structured `Link` preload entries. */
function validatePreloads(preload: unknown): string[] {
  if (!Array.isArray(preload)) {
    return ['preload must be an array'];
  }
  const errors: string[] = [];
  for (let i = 0; i < preload.length; i++) {
    const item = preload[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`preload[${i}] must be an object`);
      continue;
    }
    const p = item as Record<string, unknown>;
    if (typeof p['url'] !== 'string' || p['url'] === '') {
      errors.push(`preload[${i}].url must be a non-empty string`);
    }
    if (p['as'] !== undefined && (typeof p['as'] !== 'string' || p['as'] === '')) {
      errors.push(`preload[${i}].as must be a non-empty string`);
    }
    if (
      p['crossorigin'] !== undefined &&
      p['crossorigin'] !== 'anonymous' &&
      p['crossorigin'] !== 'use-credentials'
    ) {
      errors.push(`preload[${i}].crossorigin must be "anonymous" or "use-credentials"`);
    }
    if (
      p['fetchPriority'] !== undefined &&
      p['fetchPriority'] !== 'high' &&
      p['fetchPriority'] !== 'low' &&
      p['fetchPriority'] !== 'auto'
    ) {
      errors.push(`preload[${i}].fetchPriority must be "high", "low", or "auto"`);
    }
    if (p['media'] !== undefined && (typeof p['media'] !== 'string' || p['media'] === '')) {
      errors.push(`preload[${i}].media must be a non-empty string`);
    }
  }
  return errors;
}

/** Validate the `compressed` variants record. */
function validateCompressed(compressed: unknown): string[] {
  if (typeof compressed !== 'object' || compressed === null || Array.isArray(compressed)) {
    return ['compressed must be an object keyed by format (br, zst, gz)'];
  }
  const errors: string[] = [];
  for (const [format, variant] of Object.entries(compressed as Record<string, unknown>)) {
    if (!COMPRESSED_FORMATS.has(format)) {
      errors.push(`compressed has unknown format '${format}'`);
      continue;
    }
    if (typeof variant !== 'object' || variant === null || Array.isArray(variant)) {
      errors.push(`compressed.${format} must be an object`);
      continue;
    }
    const v = variant as Record<string, unknown>;
    if (typeof v['path'] !== 'string' || v['path'] === '') {
      errors.push(`compressed.${format}.path must be a non-empty string`);
    }
    if (typeof v['size'] !== 'number' || !Number.isInteger(v['size']) || v['size'] < 0) {
      errors.push(`compressed.${format}.size must be a non-negative integer`);
    }
    if (
      v['sha256'] !== undefined &&
      (typeof v['sha256'] !== 'string' || v['sha256'] === '' || !BASE64URL_RE.test(v['sha256']))
    ) {
      errors.push(`compressed.${format}.sha256 must be a base64url-encoded string`);
    }
  }
  return errors;
}

/** Validate per-type media metadata and HTML-generation hints. */
function validateTypeMeta(e: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const checkString = (key: string) => {
    if (e[key] !== undefined && typeof e[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  };
  const checkBoolean = (key: string) => {
    if (e[key] !== undefined && typeof e[key] !== 'boolean') {
      errors.push(`${key} must be a boolean`);
    }
  };
  const checkDimension = (key: string) => {
    const value = e[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    ) {
      errors.push(`${key} must be a non-negative integer`);
    }
  };
  const checkDuration = (key: string) => {
    const value = e[key];
    if (value !== undefined && (typeof value !== 'number' || value < 0)) {
      errors.push(`${key} must be a non-negative number`);
    }
  };

  for (const key of [
    'media',
    'family',
    'weight',
    'style',
    'display',
    'stretch',
    'unicodeRange',
    'poster',
    'title',
    'lang',
    'charset',
    'source',
  ]) {
    checkString(key);
  }
  for (const key of ['entry', 'async', 'defer', 'inline', 'isEntry', 'isFallback']) {
    checkBoolean(key);
  }
  for (const key of ['width', 'height']) {
    checkDimension(key);
  }
  checkDuration('duration');

  if (e['module'] !== undefined && e['module'] !== 'esm' && e['module'] !== 'script') {
    errors.push('module must be "esm" or "script"');
  }
  if (e['loading'] !== undefined && e['loading'] !== 'lazy' && e['loading'] !== 'eager') {
    errors.push('loading must be "lazy" or "eager"');
  }
  if (
    e['decoding'] !== undefined &&
    e['decoding'] !== 'async' &&
    e['decoding'] !== 'sync' &&
    e['decoding'] !== 'auto'
  ) {
    errors.push('decoding must be "async", "sync", or "auto"');
  }
  if (
    e['deps'] !== undefined &&
    (!Array.isArray(e['deps']) || e['deps'].some((d) => typeof d !== 'string'))
  ) {
    errors.push('deps must be an array of strings');
  }
  if (e['srcset'] !== undefined) {
    if (!Array.isArray(e['srcset'])) {
      errors.push('srcset must be an array');
    } else {
      for (const candidate of e['srcset']) {
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          typeof (candidate as Record<string, unknown>)['url'] !== 'string'
        ) {
          errors.push('srcset entries must have a string url');
          break;
        }
        const c = candidate as Record<string, unknown>;
        const width = c['width'];
        if (
          width !== undefined &&
          (typeof width !== 'number' || !Number.isInteger(width) || width < 0)
        ) {
          errors.push('srcset entries width must be a non-negative integer');
          break;
        }
        const density = c['density'];
        if (density !== undefined && (typeof density !== 'number' || density <= 0)) {
          errors.push('srcset entries density must be a positive number');
          break;
        }
      }
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
