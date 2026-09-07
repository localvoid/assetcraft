import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import type { CompressFormat } from '../compress.js';
import type { Manifest, ManifestEntry } from '../manifest.js';
import { urlToString } from '../manifest.js';
import { diffManifests } from '../manifest/diff.js';

/** Compressed variant file suffixes, matching the build pipeline. */
const COMPRESSED_VARIANTS: Record<CompressFormat, string> = {
  br: '.br',
  zstd: '.zst',
  gzip: '.gz',
};

/**
 * A single deployable file: a manifest entry or one of its prebuilt
 * compressed variants. `entry` is the source manifest entry, kept so
 * external scripts (uploaders, Rust `include_bytes!` generators) don't
 * need to re-join metadata.
 */
export interface DeployFile {
  /** Public URL (entries) or entry URL + variant suffix (variants). */
  readonly url: string;
  /** Disk path, manifest-relative until `resolveDeployPaths`. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly mime: string;
  readonly immutable: boolean;
  readonly headers: Record<string, string> | undefined;
  /** Variant encoding for compressed rows, `undefined` for identity. */
  readonly encoding: CompressFormat | undefined;
  readonly entry: ManifestEntry;
}

/** A `DeployFile` with an absolute disk `path`, ready for byte reads. */
export interface ResolvedDeployFile extends DeployFile {
  readonly path: string;
}

export interface ListDeployFilesOptions {
  /**
   * Include object-URL (`{ origin, path }`) entries. Defaults to `false`:
   * external-origin files aren't owned by this deployment. History
   * tracking (see `./history.js`) still covers them.
   */
  readonly includeExternal?: boolean;
}

function toDeployFile(
  entry: ManifestEntry,
  url: string,
  path: string,
  size: number,
  sha256: string,
  encoding: CompressFormat | undefined,
): DeployFile {
  return {
    url,
    path,
    size,
    sha256,
    mime: entry.mime,
    immutable: entry.immutable === true,
    headers: entry.headers,
    encoding,
    entry,
  };
}

/** Expand one entry into identity + compressed-variant rows. */
function expandEntry(entry: ManifestEntry, includeExternal: boolean): DeployFile[] {
  if (includeExternal !== true && typeof entry.url !== 'string') {
    return [];
  }
  const url = urlToString(entry.url);
  const rows: DeployFile[] = [
    toDeployFile(entry, url, entry.path, entry.size, entry.sha256, void 0),
  ];
  const compressed = entry.compressed;
  if (compressed !== void 0) {
    for (const format of Object.keys(COMPRESSED_VARIANTS) as CompressFormat[]) {
      const variant = compressed[format];
      if (variant !== void 0) {
        rows.push(
          toDeployFile(
            entry,
            url + COMPRESSED_VARIANTS[format],
            variant.path,
            variant.size,
            variant.sha256 ?? entry.sha256,
            format,
          ),
        );
      }
    }
  }
  return rows;
}

/**
 * Expand a manifest into deployable files: one row per entry plus one
 * row per recorded compressed variant. Manifest order is preserved.
 */
export function listDeployFiles(
  manifest: Manifest,
  options?: ListDeployFilesOptions,
): DeployFile[] {
  const includeExternal = options?.includeExternal ?? false;
  return manifest.flatMap((entry) => expandEntry(entry, includeExternal));
}

/**
 * Resolve manifest-relative `path`s against the manifest's directory.
 * Returns rows with absolute paths, suitable for `readDeployBytes` or
 * an external embed generator.
 */
export function resolveDeployPaths(
  files: readonly DeployFile[],
  manifestDir: string,
): ResolvedDeployFile[] {
  return files.map((file) => ({ ...file, path: join(manifestDir, file.path) }));
}

/**
 * Read a resolved file's bytes from disk.
 */
export async function readDeployBytes(file: Pick<ResolvedDeployFile, 'path'>): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(file.path));
}

/**
 * A removed file awaiting deletion. `absences` counts consecutive
 * deploys the path has been missing from the manifest.
 */
export interface PendingRemoval {
  readonly path: string;
  readonly url: string;
  readonly absences: number;
}

export interface PlanDeployOptions extends ListDeployFilesOptions {
  /**
   * Consecutive absences before a removed file is deleted. Defaults to
   * `2` (survives one stale-HTML window / failed deploy). `1` deletes
   * immediately.
   */
  readonly keepDeploys?: number;
}

export interface DeployPlan {
  /** New or content-changed files to upload (identity + variants). */
  readonly add: DeployFile[];
  /** Files absent long enough to delete now (identity + variants). */
  readonly remove: DeployFile[];
  /** Pending state to persist for the next deploy cycle. */
  readonly pendingRemove: PendingRemoval[];
  /** Entries identical in both manifests (kept as-is). */
  readonly unchanged: number;
}

/**
 * Plan a deployment from the previous and next manifests. Pure and
 * dry-runnable: the external script uploads `upload`, deletes
 * `removeNow`, and persists `pending` plus history (see `./state.js`).
 *
 * Removal grace is count-based (deterministic in CI): a path missing
 * from `next` gains one absence per plan and is deleted once
 * `absences >= keepDeploys`. Reappearing paths clear their counter
 * (self-healing on rollback).
 */
export function planDeploy(
  prev: Manifest | undefined,
  next: Manifest,
  pending?: readonly PendingRemoval[],
  options?: PlanDeployOptions,
): DeployPlan {
  const keepDeploys = options?.keepDeploys ?? 2;
  if (keepDeploys < 1 || !Number.isInteger(keepDeploys)) {
    throw new Error(`Invalid keepDeploys '${keepDeploys}': expected a positive integer`);
  }
  const includeExternal = options?.includeExternal ?? false;
  if (prev === void 0) {
    return {
      add: next.flatMap((entry) => expandEntry(entry, includeExternal)),
      remove: [],
      pendingRemove: [],
      unchanged: 0,
    };
  }
  const diff = diffManifests(prev, next);
  const uploadPaths = new Set<string>();
  for (const entry of diff.added) {
    uploadPaths.add(entry.path);
  }
  for (const c of diff.changed) {
    if (c.hashChanged) {
      uploadPaths.add(c.next.path);
    }
  }
  const add = next.flatMap((entry) =>
    uploadPaths.has(entry.path) ? expandEntry(entry, includeExternal) : [],
  );

  const prevByPath = new Map(prev.map((entry) => [entry.path, entry]));
  const nextPaths = new Set(next.map((entry) => entry.path));
  const prevAbsences = new Map((pending ?? []).map((item) => [item.path, item.absences]));
  // Union of freshly removed paths and carried-over pending keys.
  const candidates = new Set<string>(prevAbsences.keys());
  for (const entry of diff.removed) {
    candidates.add(entry.path);
  }
  const remove: DeployFile[] = [];
  const pendingRemove: PendingRemoval[] = [];
  for (const path of candidates) {
    if (nextPaths.has(path)) {
      continue;
    }
    const entry = prevByPath.get(path);
    if (entry === void 0) {
      continue;
    }
    const absences = (prevAbsences.get(path) ?? 0) + 1;
    if (absences >= keepDeploys) {
      remove.push(...expandEntry(entry, includeExternal));
    } else {
      pendingRemove.push({ path, url: urlToString(entry.url), absences });
    }
  }
  return {
    add,
    remove,
    pendingRemove,
    unchanged: diff.unchanged.length,
  };
}
