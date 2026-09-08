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
 * const deploy = await Deploy.open({
 *   manifests: ['dist/html-manifest.json', 'dist/js-manifest.json'],
 *   deployPath: 'dist/manifest.deploy.json',
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
  hash: string;
  removedAt?: number;
}

/**
 * A removed file awaiting deletion. `absences` counts consecutive
 * deploys the path has been missing from its manifest. `source` is the
 * manifest path the entry belonged to (files are keyed by source + path,
 * so different manifests may use the same relative path).
 */
export interface PendingRemoval {
  readonly source: string;
  readonly path: string;
  readonly url: string;
  readonly absences: number;
}

/**
 * A single deployable file: a manifest entry or one of its prebuilt
 * compressed variants. `entry` is the source manifest entry, kept so
 * external scripts (uploaders, Rust `include_bytes!` generators) don't
 * need to re-join metadata. `entry` also identifies which manifest
 * directory {@link Deploy.resolve} uses for the file.
 */
export interface DeployFile {
  /** Public URL (entries) or entry URL + variant suffix (variants). */
  readonly url: string;
  /** Disk path, manifest-relative until `resolve`. */
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

/** Options for {@link Deploy.open}. */
export interface DeployOptions {
  /**
   * Paths to JSON manifest files, one per build tool. Combined in order;
   * each manifest's entry paths resolve against its own directory.
   * Must be non-empty with no duplicates (paths are source identity).
   */
  readonly manifests: string[];
  /** Deploy-state sidecar path (required, never derived). */
  readonly deployPath: string;
  /**
   * Consecutive absences before a removed file is deleted. Defaults to
   * `2` (survives one stale-HTML window / failed deploy). `1` deletes
   * immediately.
   */
  readonly keepDeploys?: number;
  /**
   * Include object-URL (`{ origin, path }`) entries. Defaults to `false`:
   * external-origin files aren't owned by this deployment. History
   * tracking still covers them.
   */
  readonly includeExternal?: boolean;
  /**
   * Retention window for inactive history URLs, in seconds. Defaults to
   * 365 days. Independent of file-deletion grace (`keepDeploys`).
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
 * {@link Deploy.open}, inspect files with {@link files}, diff with
 * {@link plan}, persist with {@link commit}.
 */
export class Deploy {
  /** Combined entries of all manifests, in order. */
  readonly manifest: Manifest;
  /** Manifest source paths as passed to {@link Deploy.open}. */
  readonly manifests: readonly string[];
  /** Deploy-state sidecar path. */
  readonly deployPath: string;

  /** Current manifests with their resolve directories. */
  #loaded: LoadedManifest[];
  /** Previous manifests restored from deploy state. */
  #prevRecords: PrevManifestRecord[];
  /** Entry identity → base directory for {@link resolve}. */
  #dirs: Map<ManifestEntry, string>;
  /** History entries carried from the loaded state, updated by `commit`. */
  #history: DeployHistoryEntry[];
  /** Pending removals carried from the loaded state, updated by `commit`. */
  #pending: PendingRemoval[];
  #keepDeploys: number;
  #includeExternal: boolean;
  #purgeDuration: number;

  private constructor(
    loaded: LoadedManifest[],
    deployPath: string,
    prevRecords: PrevManifestRecord[],
    history: DeployHistoryEntry[],
    pending: PendingRemoval[],
    keepDeploys: number,
    includeExternal: boolean,
    purgeDuration: number,
  ) {
    this.manifest = loaded.flatMap((l) => l.entries);
    this.manifests = loaded.map((l) => l.source);
    this.deployPath = deployPath;
    this.#loaded = loaded;
    this.#prevRecords = prevRecords;
    this.#dirs = new Map();
    for (const l of loaded) {
      for (const entry of l.entries) {
        this.#dirs.set(entry, l.dir);
      }
    }
    for (const record of prevRecords) {
      for (const entry of record.entries) {
        if (!this.#dirs.has(entry)) {
          this.#dirs.set(entry, record.dir);
        }
      }
    }
    this.#history = history;
    this.#pending = pending;
    this.#keepDeploys = keepDeploys;
    this.#includeExternal = includeExternal;
    this.#purgeDuration = purgeDuration;
  }

  /**
   * Load the manifests, load the deploy-state sidecar (previous
   * manifests, history, pending), and run the history collision check.
   * @throws On missing/invalid manifests, corrupt state, invalid
   *   `keepDeploys`, or immutable URL reuse with different content.
   */
  static async open(options: DeployOptions): Promise<Deploy> {
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
    const keepDeploys = options.keepDeploys ?? 2;
    if (keepDeploys < 1 || !Number.isInteger(keepDeploys)) {
      throw new Error(`Invalid keepDeploys '${keepDeploys}': expected a positive integer`);
    }
    const loaded: LoadedManifest[] = [];
    for (const source of options.manifests) {
      loaded.push({ source, dir: dirname(source), entries: await loadManifestFile(source) });
    }
    let history: DeployHistoryEntry[] = [];
    let pending: PendingRemoval[] = [];
    let prevRecords: PrevManifestRecord[] = [];
    const state = await loadDeployState(options.deployPath);
    if (state !== undefined) {
      history = state.history;
      pending = state.pending;
      prevRecords = state.prevManifests;
    }
    const manifest = loaded.flatMap((l) => l.entries);
    checkManifestAgainstHistory(manifest, history);
    return new Deploy(
      loaded,
      options.deployPath,
      prevRecords,
      history,
      pending,
      keepDeploys,
      options.includeExternal ?? false,
      options.purgeDuration ?? DEFAULT_PURGE_DURATION,
    );
  }

  /**
   * Expand the manifests into deployable files: one row per entry plus
   * one row per recorded compressed variant. Manifest order is preserved
   * within each source, sources in the order passed to {@link open}.
   */
  files(): DeployFile[] {
    return this.manifest.flatMap((entry) => expandEntry(entry, this.#includeExternal));
  }

  /**
   * Resolve manifest-relative `path`s against each entry's manifest
   * directory. Defaults to {@link files}; returns rows with absolute
   * paths, suitable for {@link read} or an external embed generator.
   * @throws On files whose entry wasn't opened by this `Deploy`.
   */
  resolve(files?: readonly DeployFile[]): ResolvedDeployFile[] {
    return (files ?? this.files()).map((file) => {
      const dir = this.#dirs.get(file.entry);
      if (dir === undefined) {
        throw new Error(`Unknown deploy file: '${file.path}'`);
      }
      return { ...file, path: join(dir, file.path) };
    });
  }

  /** Read a resolved file's bytes from disk. */
  async read(file: Pick<ResolvedDeployFile, 'path'>): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(file.path));
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
   * from its manifest gains one absence per plan and is deleted once
   * `absences >= keepDeploys`. Reappearing paths clear their counter
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
    const currentBySource = new Map(this.#loaded.map((l) => [l.source, l.entries]));
    const prevBySource = new Map(this.#prevRecords.map((r) => [r.source, r]));
    const pendingBySource = new Map<string, PendingRemoval[]>();
    for (const item of this.#pending) {
      const list = pendingBySource.get(item.source);
      if (list === undefined) {
        pendingBySource.set(item.source, [item]);
      } else {
        list.push(item);
      }
    }
    // Current sources in open() order, then snapshots whose source is gone.
    const ordered = [...this.manifests];
    for (const record of this.#prevRecords) {
      if (!currentBySource.has(record.source)) {
        ordered.push(record.source);
      }
    }
    for (const source of ordered) {
      const current = currentBySource.get(source) ?? [];
      const record = prevBySource.get(source);
      if (record === undefined) {
        for (const entry of current) {
          add.push(...expandEntry(entry, this.#includeExternal));
        }
        continue;
      }
      const diff = diffManifests(record.entries, current);
      const uploadPaths = new Set<string>();
      for (const entry of diff.added) {
        uploadPaths.add(entry.path);
      }
      for (const c of diff.changed) {
        if (c.hashChanged) {
          uploadPaths.add(c.next.path);
        }
      }
      for (const entry of current) {
        if (uploadPaths.has(entry.path)) {
          add.push(...expandEntry(entry, this.#includeExternal));
        }
      }
      unchanged += diff.unchanged.length;

      const prevByPath = new Map(record.entries.map((entry) => [entry.path, entry]));
      const nextPaths = new Set(current.map((entry) => entry.path));
      const carried = pendingBySource.get(source) ?? [];
      const prevAbsences = new Map(carried.map((item) => [item.path, item.absences]));
      // Union of freshly removed paths and carried-over pending keys.
      const candidates = new Set<string>(prevAbsences.keys());
      for (const entry of diff.removed) {
        candidates.add(entry.path);
      }
      for (const path of candidates) {
        if (nextPaths.has(path)) {
          continue;
        }
        const entry = prevByPath.get(path);
        if (entry === undefined) {
          continue;
        }
        const absences = (prevAbsences.get(path) ?? 0) + 1;
        if (absences >= this.#keepDeploys) {
          remove.push(...expandEntry(entry, this.#includeExternal));
        } else {
          pendingRemove.push({ source, path, url: urlToString(entry.url), absences });
        }
      }
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
   * @param path - State file path; defaults to this `deployPath`.
   * @returns The committed plan.
   */
  async commit(path?: string): Promise<DeployPlan> {
    const plan = this.plan();
    this.#history = recordHistoryEntries(this.manifest, this.#history, this.#purgeDuration);
    this.#pending = plan.pendingRemove;
    this.#prevRecords = snapshotRecords(this.#loaded, this.#prevRecords, plan.pendingRemove);
    await updateFile(
      path ?? this.deployPath,
      JSON.stringify(
        { history: this.#history, pending: this.#pending, prevManifests: this.#prevRecords },
        undefined,
        2,
      ),
    );
    return plan;
  }
}

/** One opened manifest with its source path and resolve directory. */
interface LoadedManifest {
  readonly source: string;
  readonly dir: string;
  readonly entries: Manifest;
}

/** A previous manifest snapshot persisted in deploy state. */
interface PrevManifestRecord {
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
  loaded: LoadedManifest[],
  prevRecords: PrevManifestRecord[],
  pending: PendingRemoval[],
): PrevManifestRecord[] {
  const prevBySource = new Map(prevRecords.map((record) => [record.source, record]));
  const loadedSources = new Set(loaded.map((l) => l.source));
  const pendingPaths = new Map<string, Set<string>>();
  for (const item of pending) {
    let paths = pendingPaths.get(item.source);
    if (paths === undefined) {
      paths = new Set();
      pendingPaths.set(item.source, paths);
    }
    paths.add(item.path);
  }
  const next: PrevManifestRecord[] = loaded.map((l) => {
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
  readonly prevManifests: PrevManifestRecord[];
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
      typeof entry['hash'] !== 'string' ||
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
      typeof item['absences'] !== 'number' ||
      !Number.isInteger(item['absences']) ||
      item['absences'] < 1
    ) {
      throw new Error(
        'Invalid deploy state: pending items need string path/url and positive integer absences',
      );
    }
    // `source` predates multi-manifest state: unattributed items never
    // match a snapshot and are flushed on the next commit.
    const source = item['source'];
    if (source !== undefined && typeof source !== 'string') {
      throw new Error(
        'Invalid deploy state: pending items need string path/url and positive integer absences',
      );
    }
    result.push({
      source: typeof source === 'string' ? source : '',
      path: item['path'] as string,
      url: item['url'] as string,
      absences: item['absences'] as number,
    });
  }
  return result;
}

function parsePrevManifests(value: unknown): PrevManifestRecord[] {
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
 * Tracks immutable asset URL-to-hash mappings to prevent cache-colliding
 * URL reuse. Once an asset URL is published with a given content hash, the
 * same URL must never serve different content.
 */
class DeployHistory {
  /** All known entries keyed by URL (active and inactive). */
  readonly index: Map<string, DeployHistoryEntry>;
  /** URLs currently in use — re-populated each deploy via {@link add}. */
  readonly active: Set<string>;

  constructor(entries?: DeployHistoryEntry[]) {
    this.index = new Map();
    this.active = new Set();
    if (entries) {
      for (const entry of entries) {
        this.index.set(entry.url, { ...entry });
      }
    }
  }

  /** Register an immutable asset. */
  add(url: string, hash: string): void {
    const entry = this.index.get(url);
    if (entry === undefined) {
      this.index.set(url, { url, hash });
    } else if (entry.hash !== hash) {
      throw Error(`Hash collision detected for an asset with an url '${url}': ${hash}`);
    }
    this.active.add(url);
  }

  /** Remove inactive entries older than `duration` seconds. */
  purge(duration: number): void {
    const t = Math.floor(Date.now() / 1000);
    const cutoff = t - duration;
    for (const [k, v] of this.index.entries()) {
      if (this.active.has(k)) {
        if (v.removedAt !== undefined) {
          delete v.removedAt;
        }
      } else if (v.removedAt === undefined) {
        v.removedAt = t;
      } else if (cutoff > v.removedAt) {
        this.index.delete(k);
      }
    }
  }
}

/** Register a manifest's immutable entries in `history`. */
function applyManifestToHistory(manifest: Manifest, history: DeployHistory): void {
  for (const entry of manifest) {
    if (entry.immutable === true) {
      history.add(urlToString(entry.url), entry.sha256);
    }
  }
}

/**
 * Check a manifest against history: every immutable entry's URL must map
 * to the recorded content hash. Object-URL entries are included (their
 * key is origin-scoped).
 * @throws On immutable URL reuse with different content (cache collision).
 */
function checkManifestAgainstHistory(
  manifest: Manifest,
  historyEntries?: DeployHistoryEntry[],
): void {
  const history = new DeployHistory(historyEntries);
  applyManifestToHistory(manifest, history);
}

/**
 * Record a manifest's immutable entries into history and purge inactive
 * URLs past the retention window. Returns the entries to persist in the
 * deploy state file for the next deploy cycle.
 */
function recordHistoryEntries(
  manifest: Manifest,
  prevEntries?: DeployHistoryEntry[],
  purgeDuration: number = DEFAULT_PURGE_DURATION,
): DeployHistoryEntry[] {
  const history = new DeployHistory(prevEntries);
  applyManifestToHistory(manifest, history);
  history.purge(purgeDuration);
  return [...history.index.values()];
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
    toDeployFile(entry, url, entry.path, entry.size, entry.sha256, undefined),
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
