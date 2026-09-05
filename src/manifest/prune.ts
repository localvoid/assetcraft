/**
 * Pruning for build output directories. Removes files that are no longer
 * referenced by the current manifest(s), reclaiming space from stale
 * hashed assets left behind by previous builds.
 */

import { resolve } from 'node:path';

import type { Manifest } from '../manifest.js';
import { cleanDirRecursive, normalizeRelativePath, pathIsWithin } from '../file.js';

/** Options for {@link pruneDir}. */
export interface PruneOptions {
  /** Extra output-relative paths to keep, in addition to manifest entries. */
  readonly ignore?: string[];
  /**
   * Suffixes of on-disk compressed variants to keep alongside each entry
   * (e.g. `['.br', '.gz']` keeps `app-hash.js.br` for `app-hash.js`).
   * Each suffix must be a plain filename suffix without path separators.
   */
  readonly compressedSuffixes?: string[];
  /**
   * Remove directories that become empty after pruning (default `false`).
   * The output `dir` itself is never removed.
   */
  readonly removeEmptyDirs?: boolean;
}

/**
 * Collect normalized output-relative file paths referenced by `manifests`,
 * including compressed variants when `compressedSuffixes` is given.
 * @throws If any entry path is empty, absolute, references the output
 *   directory itself, escapes the output directory, or if a compressed
 *   suffix contains a path separator.
 */
export function collectManifestPaths(
  manifests: Manifest | Manifest[],
  dir: string,
  options?: Pick<PruneOptions, 'compressedSuffixes'>,
): Set<string> {
  if (options?.compressedSuffixes !== undefined) {
    for (const suffix of options.compressedSuffixes) {
      assertValidCompressedSuffix(dir, suffix);
    }
  }
  const list = asManifestList(manifests);
  const keep = new Set<string>();
  for (const manifest of list) {
    for (const entry of manifest) {
      const path = normalizeKeepPath(dir, entry.path);
      keep.add(path);
      if (options?.compressedSuffixes !== undefined) {
        for (const suffix of options.compressedSuffixes) {
          // Suffixes contain no separators, so the combination stays within
          // `dir` without re-normalizing.
          keep.add(path + suffix);
        }
      }
    }
  }
  return keep;
}

/**
 * Remove files under `dir` that are not referenced by `manifests`.
 * Manifest entry paths must be relative to `dir` and use `/` separators;
 * `./`, duplicate `/`, and `a/../` segments are normalized before matching.
 * Directories that become empty are left in place unless
 * `options.removeEmptyDirs` is set.
 * Symbolic links are removed themselves (never followed).
 * @throws If any entry path is empty, absolute, references `dir` itself,
 *   or escapes `dir`.
 */
export async function pruneDir(
  dir: string,
  manifests: Manifest | Manifest[],
  options?: PruneOptions,
): Promise<void> {
  const keep = collectManifestPaths(manifests, dir, options);
  if (options?.ignore !== undefined) {
    for (const path of options.ignore) {
      keep.add(normalizeKeepPath(dir, path));
    }
  }
  await cleanDirRecursive(dir, [...keep], { removeEmptyDirs: options?.removeEmptyDirs });
}

/** Normalize a single manifest or a list of manifests to a list. */
function asManifestList(manifests: Manifest | Manifest[]): Manifest[] {
  // Note: Array.isArray can't discriminate Manifest from Manifest[] (both
  // are arrays), so inspect the first element instead.
  const head: unknown = (manifests as Manifest)[0];
  return Array.isArray(head) ? (manifests as Manifest[]) : [manifests as Manifest];
}

/** Reject paths that are absolute or resolve outside `dir`. */
function assertWithinDir(dir: string, path: string): void {
  if (!pathIsWithin(dir, resolve(dir, path))) {
    throw Error(`Refusing to prune: path '${path}' is outside of '${dir}'`);
  }
}

/**
 * Normalize an output-relative keep path to a canonical posix form
 * (see {@link normalizeRelativePath}). A trailing `/` keeps the whole
 * subtree.
 * @throws If the path is empty, absolute, references `dir` itself, or
 *   escapes `dir`.
 */
function normalizeKeepPath(dir: string, rawPath: string): string {
  const normalized = normalizeRelativePath(rawPath);
  if (!normalized.ok) {
    if (normalized.reason === 'empty') {
      throw Error(`Refusing to prune: empty path is not allowed (dir '${dir}')`);
    }
    if (normalized.reason === 'self') {
      throw Error(
        `Refusing to prune: path '${rawPath}' references the output directory itself ('${dir}')`,
      );
    }
    throw Error(`Refusing to prune: path '${rawPath}' is outside of '${dir}'`);
  }
  assertWithinDir(dir, normalized.path);
  return normalized.path;
}

/** Reject compressed suffixes that could change the path structure. */
function assertValidCompressedSuffix(dir: string, suffix: string): void {
  if (
    suffix === '' ||
    suffix === '.' ||
    suffix === '..' ||
    suffix.includes('/') ||
    suffix.includes('\\')
  ) {
    throw Error(
      `Refusing to prune: compressed suffix '${suffix}' must be a plain filename suffix without path separators (dir '${dir}')`,
    );
  }
}
