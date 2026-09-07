import type { Manifest } from '../manifest.js';
import { urlToString } from '../manifest.js';

export interface DeployHistoryEntry {
  url: string;
  hash: string;
  removedAt?: number;
}

/**
 * Tracks immutable asset URL-to-hash mappings to prevent cache-colliding
 * URL reuse. Once an asset URL is published with a given content hash, the
 * same URL must never serve different content. Part of the deploy
 * subsystem: persisted inside the deploy state file (see `./state.js`).
 *
 * Usage:
 *   1. Load persisted entries via the constructor.
 *   2. For each immutable asset in the current manifest, call {@link add}.
 *   3. Call {@link purge} to remove entries that have been inactive beyond
 *      the retention window.
 *   4. Persist the result with `saveDeployState`.
 */
export class DeployHistory {
  /** All known entries keyed by URL (active and inactive). */
  readonly index: Map<string, DeployHistoryEntry>;
  /** URLs that are currently in use — re-populated each deploy via {@link add}. */
  readonly active: Set<string>;

  /**
   * @param entries - Previously persisted history entries (e.g. from the
   *   deploy state file).
   */
  constructor(entries?: DeployHistoryEntry[]) {
    this.index = new Map();
    this.active = new Set();
    if (entries) {
      for (const entry of entries) {
        this.index.set(entry.url, { ...entry });
      }
    }
  }

  /**
   * Register an immutable asset.
   */
  add(url: string, hash: string): void {
    const entry = this.index.get(url);
    if (entry === void 0) {
      this.index.set(url, { url, hash });
    } else if (entry.hash !== hash) {
      throw Error(`Hash collision detected for an asset with an url '${url}': ${hash}`);
    }
    this.active.add(url);
  }

  /**
   * Remove inactive entries older than `duration` seconds (default 365 days).
   */
  purge(duration: number = 31536000): void {
    const t = Math.floor(Date.now() / 1000);
    const cutoff = t - duration;
    for (const [k, v] of this.index.entries()) {
      if (this.active.has(k)) {
        if (v.removedAt !== void 0) {
          v.removedAt = void 0;
        }
      } else if (v.removedAt === void 0) {
        v.removedAt = t;
      } else if (cutoff > v.removedAt) {
        this.index.delete(k);
      }
    }
  }
}

export interface RecordHistoryOptions {
  /**
   * Retention window for inactive URLs, in seconds. Defaults to the
   * `DeployHistory` default (365 days). History retention is independent
   * of file-deletion grace (see `planDeploy` in `./files.js`).
   */
  readonly purgeDuration?: number;
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
export function checkManifest(manifest: Manifest, historyEntries?: DeployHistoryEntry[]): void {
  const history = new DeployHistory(historyEntries);
  applyManifestToHistory(manifest, history);
}

/**
 * Record a manifest's immutable entries into history and purge inactive
 * URLs past the retention window. Returns the entries to persist in the
 * deploy state file for the next deploy cycle.
 */
export function recordHistory(
  manifest: Manifest,
  prevEntries?: DeployHistoryEntry[],
  options?: RecordHistoryOptions,
): DeployHistoryEntry[] {
  const history = new DeployHistory(prevEntries);
  applyManifestToHistory(manifest, history);
  history.purge(options?.purgeDuration ?? 31536000);
  return [...history.index.values()];
}
