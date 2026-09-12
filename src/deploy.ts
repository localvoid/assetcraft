/**
 * Single-call deploy helper. Loads manifests and their deploy-state
 * sidecar, checks immutable-asset history for URL collisions, plans
 * uploads and deferred removals, persists updated state for the next
 * cycle, and returns the full embed set in-memory so callers never
 * re-read the state file.
 *
 * A build pipeline with multiple build tools (e.g. separate html, css,
 * and js pipelines) passes one manifest path per tool. Previous manifests
 * are restored from the deploy state, so callers never handle them
 * directly.
 *
 * Typical cycle:
 * ```ts
 * const { plan, embed } = await prepareDeploy({
 *   manifests: ['dist/manifest.html.json', 'dist/manifest.js.json'],
 *   path: 'pub/deploy.json',
 * });
 * // …upload plan.add, delete plan.remove, embed/bundle embed rows…
 * ```
 */

import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CompressFormat } from './compress.js';
import type { Manifest, ManifestEntry } from './manifest.js';
import { updateFile } from './file.js';
import { urlToString } from './manifest.js';
import { diffManifests } from './manifest/diff.js';
import { parseManifest, validateManifest } from './manifest/validate.js';

/** Immutable-asset URL-to-hash mapping with optional tombstone timestamp. */
export interface DeployHistoryEntry {
  url: string;
  sha256: string;
  removedAt?: number;
}

/**
 * A removed file awaiting deletion. `missedDeploys` counts consecutive
 * deploys the path has been missing from its manifest. `source` is the
 * manifest path the entry belonged to (files are keyed by source + path,
 * so different manifests may use the same relative path).
 */
export interface PendingRemoval {
  readonly source: string;
  readonly path: string;
  readonly url: string;
  readonly missedDeploys: number;
}

/**
 * A single deployable file: a manifest entry or one of its prebuilt
 * compressed variants. Per-file data (`url`, `path`, `size`, `sha256`,
 * `encoding`, `deployedAt`) lives on the row; shared metadata (`mime`,
 * `immutable`, `headers`, …) is read from `entry`.
 */
export interface DeployFile {
  /** Public URL (entries) or entry URL + variant suffix (variants). */
  readonly url: string;
  /** Absolute disk path, resolved against the entry's manifest directory. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /**
   * Variant format for compressed rows, `undefined` for identity.
   * This is a file-suffix key; use `getContentEncoding()` from
   * `./http.js` for the HTTP `Content-Encoding` value.
   */
  readonly encoding: CompressFormat | undefined;
  readonly entry: ManifestEntry;
  /** Unix seconds of the cycle that first deployed this content. */
  readonly deployedAt: number;
  /** Manifest source path this file belongs to (bundle sharding key). */
  readonly source: string;
}

/** Result of the diff phase inside {@link prepareDeploy}. */
export interface DeployPlan {
  /** New or content-changed files to upload (identity + variants). */
  readonly add: DeployFile[];
  /** Files absent long enough to delete now (identity + variants). */
  readonly remove: DeployFile[];
  /** Pending state persisted for the next cycle. */
  readonly pendingRemove: PendingRemoval[];
  /** Entries identical in both manifests (kept as-is). */
  readonly unchanged: number;
}

/** Options for {@link prepareDeploy}. */
export interface PrepareDeployOptions {
  /**
   * Paths to JSON manifest files, one per build tool. Combined in order;
   * each manifest's entry paths resolve against its own directory.
   * Must be non-empty with no duplicates (paths are source identity).
   */
  readonly manifests: string[];
  /** Deploy-state path. */
  readonly path: string;
  /**
   * Consecutive missed deploys before a removed file is deleted.
   * Defaults to `2` (survives one stale-HTML window / failed deploy).
   * `1` deletes immediately.
   */
  readonly maxMissedDeploys?: number;
  /**
   * Include object-URL (`{ origin, path }`) entries. Defaults to `false`:
   * external-origin files aren't owned by this deployment. History
   * tracking still covers them.
   */
  readonly external?: boolean;
  /**
   * Retention window for inactive history URLs, in seconds. Defaults to
   * 365 days. Independent of file-deletion grace (`maxMissedDeploys`).
   */
  readonly purgeDuration?: number;
  /** Unix seconds for this cycle. Defaults to `Math.floor(Date.now() / 1000)`. */
  readonly now?: number;
}

/** Full result of {@link prepareDeploy}. */
export interface PrepareDeployResult {
  /** Diff rows for this cycle (upload `add`, delete `remove`). */
  readonly plan: DeployPlan;
  /** Snapshots exactly as persisted for the next cycle's diff. */
  readonly snapshots: ManifestSnapshot[];
  /**
   * Full embed set: current entries plus grace-retained entries,
   * expanded to identity + variant rows. Current sources come first in
   * `manifests` order, retained entries after.
   */
  readonly embed: DeployFile[];
  /** `embed` rows from current manifests, in `manifests` order. */
  readonly current: DeployFile[];
  /** `embed` rows retained under removal grace. */
  readonly retained: DeployFile[];
  /** Entries skipped by `external: false` (current + retained candidates). */
  readonly skippedExternal: number;
  /** Unix seconds of this cycle. */
  readonly deployedAt: number;
}

/** Default history retention for inactive URLs: 365 days, in seconds. */
const DEFAULT_PURGE_DURATION = 31536000;

/** A manifest snapshot: source path with its resolve directory and entries. */
export interface ManifestSnapshot {
  readonly source: string;
  readonly dir: string;
  readonly entries: Manifest;
}

/** Per-file deploy timestamps: source -> path -> unix seconds. */
export type DeployedAtMap = Record<string, Record<string, number>>;

/**
 * Run one deploy cycle: load manifests + state, check history, diff,
 * persist history/pending/snapshots/timestamps, and return the plan
 * together with the full in-memory embed set. Callers must use the
 * returned `embed`/`snapshots` directly instead of re-reading the state
 * file.
 *
 * Removal grace is count-based (deterministic in CI): a path missing
 * from its manifest gains one miss per cycle and is deleted once
 * `missedDeploys >= maxMissedDeploys`. Reappearing paths clear their
 * counter (self-healing on rollback).
 *
 * @throws On missing/invalid manifests, corrupt state, invalid
 *   `maxMissedDeploys`, or immutable URL reuse with different content.
 */
export async function prepareDeploy(options: PrepareDeployOptions): Promise<PrepareDeployResult> {
  if (options.manifests.length === 0) {
    throw new Error('Deploy requires at least one manifest path');
  }
  const seen = new Set<string>();
  for (const source of options.manifests) {
    if (seen.has(source)) {
      throw new Error(`Duplicate manifest '${source}'`);
    }
    seen.add(source);
  }
  const maxMissedDeploys = options.maxMissedDeploys ?? 2;
  if (maxMissedDeploys < 1 || !Number.isInteger(maxMissedDeploys)) {
    throw new Error(`Invalid maxMissedDeploys '${maxMissedDeploys}': expected a positive integer`);
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(now) || now < 0) {
    throw new Error(`Invalid now '${options.now}': expected unix seconds`);
  }
  const external = options.external ?? false;
  const purgeDuration = options.purgeDuration ?? DEFAULT_PURGE_DURATION;

  const loaded: ManifestSnapshot[] = [];
  for (const source of options.manifests) {
    loaded.push({ source, dir: dirname(source), entries: await loadManifestFile(source) });
  }
  const state = await loadDeployState(options.path);
  const prevRecords = state?.prevManifests ?? [];
  const prevDeployedAt = state?.deployedAt ?? {};
  const pending = state?.pending ?? [];
  const history = state?.history ?? [];

  checkHistory(
    loaded.flatMap((l) => l.entries),
    history,
  );
  const manifest = loaded.flatMap((l) => l.entries);

  const plan = planAll(
    loaded,
    prevRecords,
    pending,
    external,
    maxMissedDeploys,
    prevDeployedAt,
    now,
  );
  const nextHistory = recordHistory(manifest, history, purgeDuration, now);
  const snapshots = snapshotRecords(loaded, prevRecords, plan.pendingRemove);
  const deployedAt = nextDeployedAt(snapshots, prevRecords, prevDeployedAt, now);
  const { current, retained, skippedExternal } = partitionEmbed(
    snapshots,
    plan.pendingRemove,
    external,
    deployedAt,
  );
  const embed = [...current, ...retained];

  await updateFile(
    options.path,
    JSON.stringify(
      { history: nextHistory, pending: plan.pendingRemove, prevManifests: snapshots, deployedAt },
      undefined,
      2,
    ),
  );
  return { plan, snapshots, embed, current, retained, skippedExternal, deployedAt: now };
}

/**
 * Diff every source against its previous snapshot (matched by source
 * path). A manifest with no snapshot uploads everything; a snapshot
 * whose source is gone has its entries treated as removed.
 */
function planAll(
  loaded: ManifestSnapshot[],
  prevRecords: ManifestSnapshot[],
  prevPending: PendingRemoval[],
  external: boolean,
  maxMissedDeploys: number,
  prevDeployedAt: DeployedAtMap,
  now: number,
): DeployPlan {
  const add: DeployFile[] = [];
  const remove: DeployFile[] = [];
  const pendingRemove: PendingRemoval[] = [];
  let unchanged = 0;
  if (prevRecords.length === 0) {
    for (const l of loaded) {
      for (const entry of l.entries) {
        add.push(...expandEntry(entry, l.source, l.dir, now, external));
      }
    }
    return { add, remove, pendingRemove, unchanged };
  }
  const currentBySource = new Map(loaded.map((l) => [l.source, l]));
  const prevBySource = new Map(prevRecords.map((r) => [r.source, r]));
  const pendingBySource = Map.groupBy(prevPending, (item) => item.source);
  const ordered = loaded.map((l) => l.source);
  for (const record of prevRecords) {
    if (!currentBySource.has(record.source)) {
      ordered.push(record.source);
    }
  }
  for (const source of ordered) {
    const partial = planSource(
      source,
      currentBySource.get(source),
      prevBySource.get(source),
      pendingBySource.get(source) ?? [],
      external,
      maxMissedDeploys,
      prevDeployedAt,
      now,
    );
    add.push(...partial.add);
    remove.push(...partial.remove);
    pendingRemove.push(...partial.pendingRemove);
    unchanged += partial.unchanged;
  }
  return { add, remove, pendingRemove, unchanged };
}

/**
 * Plan a single manifest source against its previous snapshot. A source
 * with no snapshot uploads everything; callers handle sources with no
 * snapshot and no current entries by skipping them.
 */
function planSource(
  source: string,
  loaded: ManifestSnapshot | undefined,
  record: ManifestSnapshot | undefined,
  carried: PendingRemoval[],
  external: boolean,
  maxMissedDeploys: number,
  prevDeployedAt: DeployedAtMap,
  now: number,
): { add: DeployFile[]; remove: DeployFile[]; pendingRemove: PendingRemoval[]; unchanged: number } {
  if (record === undefined) {
    return {
      add:
        loaded === undefined
          ? []
          : loaded.entries.flatMap((entry) =>
              expandEntry(entry, loaded.source, loaded.dir, now, external),
            ),
      remove: [],
      pendingRemove: [],
      unchanged: 0,
    };
  }
  const current = loaded?.entries ?? [];
  const dir = loaded?.dir ?? record.dir;
  const diff = diffManifests(record.entries, current);
  const upload = new Set([
    ...diff.added.map((entry) => entry.path),
    ...diff.changed.filter((c) => c.hashChanged).map((c) => c.next.path),
  ]);
  const add = current.flatMap((entry) =>
    upload.has(entry.path) ? expandEntry(entry, source, dir, now, external) : [],
  );

  const prevByPath = new Map(record.entries.map((entry) => [entry.path, entry]));
  const nextPaths = new Set(current.map((entry) => entry.path));
  const prevMissed = new Map(carried.map((item) => [item.path, item.missedDeploys]));
  // Union of freshly removed paths and carried-over pending keys.
  const candidates = new Set([...prevMissed.keys(), ...diff.removed.map((entry) => entry.path)]);
  const remove: DeployFile[] = [];
  const pendingRemove: PendingRemoval[] = [];
  for (const path of candidates) {
    if (nextPaths.has(path)) {
      continue;
    }
    const entry = prevByPath.get(path);
    if (entry === undefined) {
      continue;
    }
    const missedDeploys = (prevMissed.get(path) ?? 0) + 1;
    if (missedDeploys >= maxMissedDeploys) {
      remove.push(
        ...expandEntry(entry, source, record.dir, prevDeployedAt[source]?.[path] ?? now, external),
      );
    } else {
      pendingRemove.push({ source, path, url: urlToString(entry.url), missedDeploys });
    }
  }
  return { add, remove, pendingRemove, unchanged: diff.unchanged.length };
}

/**
 * Build the next cycle's snapshots: current entries plus previous
 * entries still under removal grace (referenced by `pending`), so grace
 * counting survives the snapshot advancing. Snapshots whose source is
 * gone are retained while their entries are still pending; entries that
 * reappeared or graduated to removal are dropped.
 */
function snapshotRecords(
  loaded: ManifestSnapshot[],
  prevRecords: ManifestSnapshot[],
  pending: PendingRemoval[],
): ManifestSnapshot[] {
  const prevBySource = new Map(prevRecords.map((record) => [record.source, record]));
  const loadedSources = new Set(loaded.map((l) => l.source));
  const pendingPaths = new Map<string, Set<string>>();
  for (const [source, items] of Map.groupBy(pending, (item) => item.source)) {
    pendingPaths.set(source, new Set(items.map((item) => item.path)));
  }
  const next: ManifestSnapshot[] = loaded.map((l) => {
    const currentPaths = new Set(l.entries.map((entry) => entry.path));
    const wanted = pendingPaths.get(l.source);
    const prev = prevBySource.get(l.source);
    const retained =
      prev === undefined || wanted === undefined
        ? []
        : prev.entries.filter((entry) => !currentPaths.has(entry.path) && wanted.has(entry.path));
    return { source: l.source, dir: l.dir, entries: [...l.entries, ...retained] };
  });
  for (const record of prevRecords) {
    if (!loadedSources.has(record.source)) {
      const wanted = pendingPaths.get(record.source);
      if (wanted === undefined) {
        continue;
      }
      const entries = record.entries.filter((entry) => wanted.has(entry.path));
      if (entries.length > 0) {
        next.push({ source: record.source, dir: record.dir, entries });
      }
    }
  }
  return next;
}

/**
 * Compute next-cycle deploy timestamps: carry the previous timestamp
 * when the same source + path + content hash survives, otherwise stamp
 * `now`. Covers every entry in `snapshots` (current + retained).
 */
function nextDeployedAt(
  snapshots: ManifestSnapshot[],
  prevRecords: ManifestSnapshot[],
  prevDeployedAt: DeployedAtMap,
  now: number,
): DeployedAtMap {
  const prevEntries = new Map<string, string>();
  for (const record of prevRecords) {
    for (const entry of record.entries) {
      prevEntries.set(`${record.source}\0${entry.path}`, entry.sha256);
    }
  }
  const next: DeployedAtMap = {};
  for (const snapshot of snapshots) {
    const byPath: Record<string, number> = {};
    for (const entry of snapshot.entries) {
      const key = `${snapshot.source}\0${entry.path}`;
      byPath[entry.path] =
        prevEntries.get(key) === entry.sha256
          ? (prevDeployedAt[snapshot.source]?.[entry.path] ?? now)
          : now;
    }
    next[snapshot.source] = byPath;
  }
  return next;
}

/**
 * Partition committed snapshots into current vs grace-retained rows and
 * count external-origin entries skipped by `external: false`. An entry
 * is retained when its source + path is referenced by `pending`;
 * everything else is current. Snapshot order is preserved within each
 * partition.
 */
function partitionEmbed(
  snapshots: ManifestSnapshot[],
  pending: PendingRemoval[],
  external: boolean,
  deployedAt: DeployedAtMap,
): { current: DeployFile[]; retained: DeployFile[]; skippedExternal: number } {
  const retainedKeys = new Set(pending.map((item) => `${item.source}\0${item.path}`));
  const current: DeployFile[] = [];
  const retained: DeployFile[] = [];
  let skippedExternal = 0;
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      if (external !== true && typeof entry.url !== 'string') {
        skippedExternal += 1;
        continue;
      }
      const at = deployedAt[snapshot.source]?.[entry.path] ?? 0;
      const rows = expandEntry(entry, snapshot.source, snapshot.dir, at, external);
      if (retainedKeys.has(`${snapshot.source}\0${entry.path}`)) {
        retained.push(...rows);
      } else {
        current.push(...rows);
      }
    }
  }
  return { current, retained, skippedExternal };
}

/** Deploy metadata persisted between cycles in a single sidecar file. */
interface DeployState {
  /** Immutable-asset URL-to-hash mappings. */
  readonly history: DeployHistoryEntry[];
  /** Removed files awaiting deletion grace. */
  readonly pending: PendingRemoval[];
  /** Per-source manifest snapshots for the next cycle's diff. */
  readonly prevManifests: ManifestSnapshot[];
  /** Per-file deploy timestamps (source -> path -> unix seconds). */
  readonly deployedAt: DeployedAtMap;
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse serialized deploy state. All keys are required; stale files
 * from previous shapes are rejected (delete and re-run).
 * @throws On invalid payloads.
 */
function parseDeployState(data: string): DeployState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new Error(`Invalid deploy state: not valid JSON (${String(err)})`);
  }
  if (!isObject(parsed)) {
    throw new Error('Invalid deploy state: expected a JSON object');
  }
  return {
    history: parseHistoryEntries(parsed['history']),
    pending: parsePending(parsed['pending']),
    prevManifests: parsePrevManifests(parsed['prevManifests']),
    deployedAt: parseDeployedAt(parsed['deployedAt']),
  };
}

function parseHistoryEntries(value: unknown): DeployHistoryEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid deploy state: history must be an array');
  }
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry['url'] !== 'string' ||
      typeof entry['sha256'] !== 'string' ||
      (entry['removedAt'] !== undefined &&
        (typeof entry['removedAt'] !== 'number' || !Number.isInteger(entry['removedAt'])))
    ) {
      throw new Error(
        'Invalid deploy state: history entries need string url/hash and optional integer removedAt',
      );
    }
  }
  return value as DeployHistoryEntry[];
}

function parsePending(value: unknown): PendingRemoval[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid deploy state: pending must be an array');
  }
  const result: PendingRemoval[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      typeof item['source'] !== 'string' ||
      typeof item['path'] !== 'string' ||
      typeof item['url'] !== 'string' ||
      typeof item['missedDeploys'] !== 'number' ||
      !Number.isInteger(item['missedDeploys']) ||
      item['missedDeploys'] < 1
    ) {
      throw new Error(
        'Invalid deploy state: pending items need string source/path/url and positive integer missedDeploys',
      );
    }
    result.push({
      source: item['source'] as string,
      path: item['path'] as string,
      url: item['url'] as string,
      missedDeploys: item['missedDeploys'] as number,
    });
  }
  return result;
}

function parsePrevManifests(value: unknown): ManifestSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid deploy state: prevManifests must be an array');
  }
  return value.map((item) => {
    if (
      !isObject(item) ||
      typeof item['source'] !== 'string' ||
      typeof item['dir'] !== 'string' ||
      !Array.isArray(item['entries'])
    ) {
      throw new Error(
        'Invalid deploy state: prevManifests entries need string source/dir and an entries array',
      );
    }
    const problems = validateManifest(item['entries']);
    if (problems.length > 0) {
      throw new Error(
        `Invalid deploy state: prev manifest '${item['source']}' is invalid: ${problems.join('; ')}`,
      );
    }
    return {
      source: item['source'] as string,
      dir: item['dir'] as string,
      entries: item['entries'] as Manifest,
    };
  });
}

function parseDeployedAt(value: unknown): DeployedAtMap {
  if (!isObject(value)) {
    throw new Error('Invalid deploy state: deployedAt must be an object');
  }
  const result: DeployedAtMap = {};
  for (const [source, byPath] of Object.entries(value)) {
    if (!isObject(byPath)) {
      throw new Error('Invalid deploy state: deployedAt entries must be objects');
    }
    const paths: Record<string, number> = {};
    for (const [path, at] of Object.entries(byPath)) {
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) {
        throw new Error('Invalid deploy state: deployedAt values must be unix seconds');
      }
      paths[path] = at;
    }
    result[source] = paths;
  }
  return result;
}

/**
 * Load deploy state. Returns `undefined` when the file is missing
 * (first deploy). A corrupt file throws: silently dropping history
 * would allow immutable URL reuse (cache collisions).
 */
async function loadDeployState(path: string): Promise<DeployState | undefined> {
  try {
    return parseDeployState(await fs.readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(
      `Invalid deploy state '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read and parse a manifest file, wrapping errors with the file path. */
async function loadManifestFile(path: string): Promise<Manifest> {
  try {
    return parseManifest(await fs.readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Invalid manifest '${path}': file not found`);
    }
    throw new Error(
      `Invalid manifest '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check a manifest against history: every immutable entry's URL must map
 * to the recorded content hash. Object-URL entries are included (their
 * key is origin-scoped).
 * @throws On immutable URL reuse with different content (cache collision).
 */
function checkHistory(manifest: Manifest, prevEntries?: DeployHistoryEntry[]): void {
  const hashes = new Map(prevEntries?.map((entry) => [entry.url, entry.sha256]));
  for (const entry of manifest) {
    if (entry.immutable !== true) {
      continue;
    }
    const url = urlToString(entry.url);
    const known = hashes.get(url);
    if (known === undefined) {
      hashes.set(url, entry.sha256);
    } else if (known !== entry.sha256) {
      throw Error(`Hash collision detected for an asset with an url '${url}': ${entry.sha256}`);
    }
  }
}

/**
 * Record a manifest's immutable entries into history and purge inactive
 * URLs past the retention window. Returns the entries to persist in the
 * deploy state file for the next deploy cycle.
 */
function recordHistory(
  manifest: Manifest,
  prevEntries: DeployHistoryEntry[],
  purgeDuration: number,
  now: number,
): DeployHistoryEntry[] {
  const index = new Map(prevEntries.map((entry) => [entry.url, { ...entry }]));
  const active = new Set<string>();
  for (const entry of manifest) {
    if (entry.immutable !== true) {
      continue;
    }
    const url = urlToString(entry.url);
    const known = index.get(url);
    if (known === undefined) {
      index.set(url, { url, sha256: entry.sha256 });
    } else if (known.sha256 !== entry.sha256) {
      throw Error(`Hash collision detected for an asset with an url '${url}': ${entry.sha256}`);
    }
    active.add(url);
  }
  purgeInactive(index, active, purgeDuration, now);
  return [...index.values()];
}

/** Remove inactive entries older than `duration` seconds. */
function purgeInactive(
  index: Map<string, DeployHistoryEntry>,
  active: ReadonlySet<string>,
  duration: number,
  now: number,
): void {
  const cutoff = now - duration;
  for (const [url, entry] of index.entries()) {
    if (active.has(url)) {
      if (entry.removedAt !== undefined) {
        delete entry.removedAt;
      }
    } else if (entry.removedAt === undefined) {
      entry.removedAt = now;
    } else if (cutoff > entry.removedAt) {
      index.delete(url);
    }
  }
}

function toDeployFile(
  entry: ManifestEntry,
  source: string,
  url: string,
  path: string,
  size: number,
  sha256: string,
  encoding: CompressFormat | undefined,
  deployedAt: number,
): DeployFile {
  return {
    url,
    path,
    size,
    sha256,
    encoding,
    entry,
    deployedAt,
    source,
  };
}

/** Expand one entry into identity + compressed-variant rows with absolute paths. */
function expandEntry(
  entry: ManifestEntry,
  source: string,
  dir: string,
  deployedAt: number,
  external: boolean,
): DeployFile[] {
  if (external !== true && typeof entry.url !== 'string') {
    return [];
  }
  const url = urlToString(entry.url);
  const rows: DeployFile[] = [
    toDeployFile(
      entry,
      source,
      url,
      join(dir, entry.path),
      entry.size,
      entry.sha256,
      undefined,
      deployedAt,
    ),
  ];
  const compressed = entry.compressed;
  if (compressed !== undefined) {
    for (const format of Object.keys(compressed) as CompressFormat[]) {
      const variant = compressed[format];
      if (variant !== undefined) {
        rows.push(
          toDeployFile(
            entry,
            source,
            `${url}.${format}`,
            join(dir, variant.path),
            variant.size,
            variant.sha256 ?? entry.sha256,
            format,
            deployedAt,
          ),
        );
      }
    }
  }
  return rows;
}
