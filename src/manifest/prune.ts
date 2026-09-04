/**
 * Pruning for build output directories. Removes files that are no longer
 * referenced by the current manifest(s), reclaiming space from stale
 * hashed assets left behind by previous builds.
 */

import { resolve } from 'node:path';

import type { Manifest } from '../manifest.js';
import { cleanDirRecursive, pathIsWithin } from '../file.js';

/** Options for {@link pruneDir}. */
export interface PruneOptions {
  /** Extra output-relative paths to keep, in addition to manifest entries. */
  readonly ignore?: string[];
  /**
   * Suffixes of on-disk compressed variants to keep alongside each entry
   * (e.g. `['.br', '.gz']` keeps `app-hash.js.br` for `app-hash.js`).
   */
  readonly compressedSuffixes?: string[];
}

/**
 * Collect output-relative file paths referenced by `manifests`,
 * including compressed variants when `compressedSuffixes` is given.
 * @throws If any entry path is absolute or escapes the output directory.
 */
export function collectManifestPaths(
  manifests: Manifest | Manifest[],
  dir: string,
  options?: Pick<PruneOptions, 'compressedSuffixes'>,
): Set<string> {
  const list = asManifestList(manifests);
  const keep = new Set<string>();
  for (const manifest of list) {
    for (const entry of manifest) {
      assertWithinDir(dir, entry.path);
      keep.add(entry.path);
      if (options?.compressedSuffixes !== undefined) {
        for (const suffix of options.compressedSuffixes) {
          keep.add(entry.path + suffix);
        }
      }
    }
  }
  return keep;
}

/**
 * Remove files under `dir` that are not referenced by `manifests`.
 * Manifest entry paths must be relative to `dir`. Directories that
 * become empty are left in place.
 * @throws If any entry path is absolute or escapes `dir`.
 */
export async function pruneDir(
  dir: string,
  manifests: Manifest | Manifest[],
  options?: PruneOptions,
): Promise<void> {
  const keep = collectManifestPaths(manifests, dir, options);
  if (options?.ignore !== undefined) {
    for (const path of options.ignore) {
      assertWithinDir(dir, path);
      keep.add(path);
    }
  }
  await cleanDirRecursive(dir, [...keep]);
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
