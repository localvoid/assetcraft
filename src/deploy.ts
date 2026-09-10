/**
 * Stateful deploy helper. Loads manifests and their deploy-state sidecar,
 * checks immutable-asset history for URL collisions, plans uploads and
 * deferred removals, and persists updated state for the next cycle.
 *
 * A build pipeline with multiple build tools (e.g. separate html, css,
 * and js pipelines) passes one manifest path per tool. Previous manifests
 * are read back from the deploy state written by the last {@link commit},
 * so callers never handle them directly.
 *
 * Typical cycle:
 * ```ts
 * const deploy = await Deploy.init({
 *   manifests: ['dist/manifest.html.json', 'dist/manifest.js.json'],
 *   path: 'pub/deploy.json',
 * });
 * const plan = deploy.plan();
 * // …upload plan.add, delete plan.remove…
 * await deploy.commit();
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
 * `encoding`) lives on the row; shared metadata (`mime`, `immutable`,
 * `headers`, …) is read from `entry`.
 */
export interface DeployFile {
  /** Public URL (entries) or entry URL + variant suffix (variants). */
  readonly url: string;
  /** Absolute disk path, resolved against the entry's manifest directory. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Variant encoding for compressed rows, `undefined` for identity. */
  readonly encoding: CompressFormat | undefined;
  readonly entry: ManifestEntry;
}

/** Result of {@link Deploy.plan}. */
export interface DeployPlan {
  /** New or content-changed files to upload (identity + variants). */
  readonly add: DeployFile[];
  /** Files absent long enough to delete now (identity + variants). */
  readonly remove: DeployFile[];
  /** Pending state persisted by {@link Deploy.commit} for the next cycle. */
  readonly pendingRemove: PendingRemoval[];
  /** Entries identical in both manifests (kept as-is). */
  readonly unchanged: number;
}

/** Options for {@link Deploy.init}. */
export interface DeployOptions {
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
}

/** Default history retention for inactive URLs: 365 days, in seconds. */
const DEFAULT_PURGE_DURATION = 31536000;

/** Compressed variant file suffixes, matching the build pipeline. */
const COMPRESSED_VARIANTS: Record<CompressFormat, string> = {
  br: '.br',
  zstd: '.zst',
  gzip: '.gz',
};

/**
 * Deploy — stateful facade over the deploy cycle. Open with
 * {@link Deploy.init}, inspect files with {@link files}, diff with
 * {@link plan}, persist with {@link commit}.
 */
export class Deploy {
  /** Combined entries of all manifests, in order. */
  readonly manifest: Manifest;
  /** Manifest source paths as passed to {@link Deploy.init}. */
  readonly manifests: readonly string[];
  /** Deploy-state path. */
  readonly path: string;

  /** Current manifests with their resolve directories. */
  #loaded: ManifestSnapshot[];
  /** Previous manifests restored from deploy state. */
  #prevRecords: ManifestSnapshot[];
  /** History entries carried from the loaded state, updated by `commit`. */
  #history: DeployHistoryEntry[];
  /** Pending removals carried from the loaded state, updated by `commit`. */
  #pending: PendingRemoval[];
  #maxMissedDeploys: number;
  #external: boolean;
  #purgeDuration: number;

  private constructor(
    loaded: ManifestSnapshot[],
    path: string,
    prevRecords: ManifestSnapshot[],
    history: DeployHistoryEntry[],
    pending: PendingRemoval[],
    maxMissedDeploys: number,
    external: boolean,
    purgeDuration: number,
  ) {
    this.manifest = loaded.flatMap((l) => l.entries);
    this.manifests = loaded.map((l) => l.source);
    this.path = path;
    this.#loaded = loaded;
    this.#prevRecords = prevRecords;
    this.#history = history;
    this.#pending = pending;
    this.#maxMissedDeploys = maxMissedDeploys;
    this.#external = external;
    this.#purgeDuration = purgeDuration;
  }

  /**
   * Load the manifests, load the deploy-state sidecar (previous
   * manifests, history, pending), and run the history collision check.
   * @throws On missing/invalid manifests, corrupt state, invalid
   *   `maxMissedDeploys`, or immutable URL reuse with different content.
   */
  static async init(options: DeployOptions): Promise<Deploy> {
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
      throw new Error(
        `Invalid maxMissedDeploys '${maxMissedDeploys}': expected a positive integer`,
      );
    }
    const loaded: ManifestSnapshot[] = [];
    for (const source of options.manifests) {
      loaded.push({ source, dir: dirname(source), entries: await loadManifestFile(source) });
    }
    let history: DeployHistoryEntry[] = [];
    let pending: PendingRemoval[] = [];
    let prevRecords: ManifestSnapshot[] = [];
    const state = await loadDeployState(options.path);
    if (state !== undefined) {
      history = state.history;
      pending = state.pending;
      prevRecords = state.prevManifests;
    }
    const manifest = loaded.flatMap((l) => l.entries);
    checkHistory(manifest, history);
    return new Deploy(
      loaded,
      options.path,
      prevRecords,
      history,
      pending,
      maxMissedDeploys,
      options.external ?? false,
      options.purgeDuration ?? DEFAULT_PURGE_DURATION,
    );
  }

  /**
   * Expand the manifests into deployable files: one row per entry plus
   * one row per recorded compressed variant, with absolute disk paths.
   * Manifest order is preserved within each source, sources in the
   * order passed to {@link init}.
   */
  files(): DeployFile[] {
    return this.#loaded.flatMap((l) =>
      l.entries.flatMap((entry) => expandEntry(entry, this.#external, l.dir)),
    );
  }

  /**
   * Plan this deployment: new or content-changed files to upload, files
   * absent long enough to delete, and pending state for the next cycle.
   * Pure and dry-runnable: upload `add`, delete `remove`, then persist
   * with {@link commit}. Each manifest is diffed against its own
   * previous snapshot from deploy state (matched by source path); a
   * manifest with no snapshot uploads everything, and a snapshot whose
   * source is gone has its entries treated as removed.
   *
   * Removal grace is count-based (deterministic in CI): a path missing
   * from its manifest gains one miss per plan and is deleted once
   * `missedDeploys >= maxMissedDeploys`. Reappearing paths clear their counter
   * (self-healing on rollback).
   */
  plan(): DeployPlan {
    const add: DeployFile[] = [];
    const remove: DeployFile[] = [];
    const pendingRemove: PendingRemoval[] = [];
    let unchanged = 0;
    if (this.#prevRecords.length === 0) {
      return { add: this.files(), remove, pendingRemove, unchanged };
    }
    const currentBySource = new Map(this.#loaded.map((l) => [l.source, l]));
    const prevBySource = new Map(this.#prevRecords.map((r) => [r.source, r]));
    const pendingBySource = Map.groupBy(this.#pending, (item) => item.source);
    // Current sources in open() order, then snapshots whose source is gone.
    const ordered = [...this.manifests];
    for (const record of this.#prevRecords) {
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
        this.#external,
        this.#maxMissedDeploys,
      );
      add.push(...partial.add);
      remove.push(...partial.remove);
      pendingRemove.push(...partial.pendingRemove);
      unchanged += partial.unchanged;
    }
    return { add, remove, pendingRemove, unchanged };
  }

  /**
   * Record the manifests' immutable entries into history (purging
   * inactive URLs past the retention window), advance pending removals
   * from {@link plan}, snapshot the current manifests as the next
   * cycle's previous manifests, and write the deploy-state sidecar —
   * creating parent directories and skipping the write when content is
   * unchanged. Updates in-memory state so further `plan()` calls see
   * the commit.
   * @returns The committed plan.
   */
  async commit(): Promise<DeployPlan> {
    const plan = this.plan();
    this.#history = recordHistory(this.manifest, this.#history, this.#purgeDuration);
    this.#pending = plan.pendingRemove;
    this.#prevRecords = snapshotRecords(this.#loaded, this.#prevRecords, plan.pendingRemove);
    await updateFile(
      this.path,
      JSON.stringify(
        { history: this.#history, pending: this.#pending, prevManifests: this.#prevRecords },
        undefined,
        2,
      ),
    );
    return plan;
  }
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
): { add: DeployFile[]; remove: DeployFile[]; pendingRemove: PendingRemoval[]; unchanged: number } {
  if (record === undefined) {
    return {
      add:
        loaded === undefined
          ? []
          : loaded.entries.flatMap((entry) => expandEntry(entry, external, loaded.dir)),
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
    upload.has(entry.path) ? expandEntry(entry, external, dir) : [],
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
      remove.push(...expandEntry(entry, external, record.dir));
    } else {
      pendingRemove.push({ source, path, url: urlToString(entry.url), missedDeploys });
    }
  }
  return { add, remove, pendingRemove, unchanged: diff.unchanged.length };
}

/** A manifest snapshot: source path with its resolve directory and entries. */
interface ManifestSnapshot {
  readonly source: string;
  readonly dir: string;
  readonly entries: Manifest;
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

/** Deploy metadata persisted between cycles in a single sidecar file. */
interface DeployState {
  /** Immutable-asset URL-to-hash mappings. */
  readonly history: DeployHistoryEntry[];
  /** Removed files awaiting deletion grace. */
  readonly pending: PendingRemoval[];
  /** Per-source manifest snapshots for the next cycle's diff. */
  readonly prevManifests: ManifestSnapshot[];
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse serialized deploy state. Missing keys default to empty arrays
 * (forward-compatible: state files written before `prevManifests`
 * existed behave as a first deploy with history enforced).
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
  };
}

function parseHistoryEntries(value: unknown): DeployHistoryEntry[] {
  if (value === undefined) {
    return [];
  }
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
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid deploy state: pending must be an array');
  }
  const result: PendingRemoval[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      typeof item['path'] !== 'string' ||
      typeof item['url'] !== 'string' ||
      typeof item['missedDeploys'] !== 'number' ||
      !Number.isInteger(item['missedDeploys']) ||
      item['missedDeploys'] < 1
    ) {
      throw new Error(
        'Invalid deploy state: pending items need string path/url and positive integer missedDeploys',
      );
    }
    // `source` predates multi-manifest state: unattributed items never
    // match a snapshot and are flushed on the next commit.
    const source = item['source'];
    if (source !== undefined && typeof source !== 'string') {
      throw new Error(
        'Invalid deploy state: pending items need string path/url and positive integer missedDeploys',
      );
    }
    result.push({
      source: typeof source === 'string' ? source : '',
      path: item['path'] as string,
      url: item['url'] as string,
      missedDeploys: item['missedDeploys'] as number,
    });
  }
  return result;
}

function parsePrevManifests(value: unknown): ManifestSnapshot[] {
  if (value === undefined) {
    return [];
  }
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
  prevEntries?: DeployHistoryEntry[],
  purgeDuration: number = DEFAULT_PURGE_DURATION,
): DeployHistoryEntry[] {
  const index = new Map(prevEntries?.map((entry) => [entry.url, { ...entry }]));
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
  purgeInactive(index, active, purgeDuration);
  return [...index.values()];
}

/** Remove inactive entries older than `duration` seconds. */
function purgeInactive(
  index: Map<string, DeployHistoryEntry>,
  active: ReadonlySet<string>,
  duration: number,
): void {
  const t = Math.floor(Date.now() / 1000);
  const cutoff = t - duration;
  for (const [url, entry] of index.entries()) {
    if (active.has(url)) {
      if (entry.removedAt !== undefined) {
        delete entry.removedAt;
      }
    } else if (entry.removedAt === undefined) {
      entry.removedAt = t;
    } else if (cutoff > entry.removedAt) {
      index.delete(url);
    }
  }
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
    encoding,
    entry,
  };
}

/** Expand one entry into identity + compressed-variant rows with absolute paths. */
function expandEntry(entry: ManifestEntry, external: boolean, dir: string): DeployFile[] {
  if (external !== true && typeof entry.url !== 'string') {
    return [];
  }
  const url = urlToString(entry.url);
  const rows: DeployFile[] = [
    toDeployFile(entry, url, join(dir, entry.path), entry.size, entry.sha256, undefined),
  ];
  const compressed = entry.compressed;
  if (compressed !== undefined) {
    for (const format of Object.keys(COMPRESSED_VARIANTS) as CompressFormat[]) {
      const variant = compressed[format];
      if (variant !== undefined) {
        rows.push(
          toDeployFile(
            entry,
            url + COMPRESSED_VARIANTS[format],
            join(dir, variant.path),
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
