export interface AssetsHistoryEntry {
  url: string;
  hash: string;
  removedAt?: number;
}

/**
 * Tracks immutable asset URL-to-hash mappings to prevent cache-colliding
 * URL reuse. Once an asset URL is published with a given content hash, the
 * same URL must never serve different content.
 *
 * Usage:
 *   1. Load persisted history via the constructor.
 *   2. For each immutable asset in the current build, call {@link add}.
 *   3. Call {@link purge} to remove entries that have been inactive beyond
 *      the retention window.
 *   4. Call {@link serialize} to persist history for the next build cycle.
 */
export class AssetsHistory {
  /** All known entries keyed by URL (active and inactive). */
  readonly index: Map<string, AssetsHistoryEntry>;
  /** URLs that are currently in use — re-populated each build via {@link add}. */
  readonly active: Set<string>;

  /**
   * @param entries - Previously serialized history entries (e.g. from a JSON
   *   file persisted between builds).
   */
  constructor(entries?: AssetsHistoryEntry[]) {
    this.index = new Map();
    this.active = new Set();
    if (entries) {
      for (const entry of entries) {
        this.index.set(entry.url, entry);
      }
    }
  }

  /**
   * Register an immutable asset.
   */
  add(url: string, hash: string): void {
    let entry = this.index.get(url);
    if (entry === void 0) {
      entry = { url, hash };
      this.index.set(url, entry);
    } else {
      if (entry.hash !== hash) {
        throw Error(`Hash collision detected for an asset with an url '${url}': ${hash}`);
      }
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
      } else {
        if (v.removedAt === void 0) {
          v.removedAt = t;
        } else if (cutoff > v.removedAt) {
          this.index.delete(k);
        }
      }
    }
  }

  /**
   * Serialize all index entries to a JSON string.
   */
  serialize(): string {
    return JSON.stringify(Array.from(this.index.values()));
  }

  /**
   * Create an `AssetsHistory` from a serialized JSON string.
   */
  static fromString(data: string): AssetsHistory {
    return new AssetsHistory(JSON.parse(data));
  }
}
