import type { AssetsHistoryEntry } from '../history.js';
import type { Manifest, ManifestEntry } from '../manifest.js';
import { AssetsHistory } from '../history.js';
import { MANIFEST_ASSET_IMMUTABLE } from '../manifest.js';

/**
 * ManifestBuilder — accumulates manifest entries during a build,
 * maintains lookup indices, and integrates with AssetsHistory to
 * prevent URL collisions for immutable assets.
 */
export class ManifestBuilder {
  /** All entries added to this build, in insertion order. */
  readonly entries: Manifest;
  /** External manifests imported via {@link import} (not part of this build). */
  readonly external: Manifest[];
  /** URL → entry index for fast lookups by public URL. */
  readonly indexByURL: Map<string, ManifestEntry>;
  /** Logical name → entry index (a single entry may have multiple names). */
  readonly indexByName: Map<string, ManifestEntry>;
  /** Filename → entry index for dedup and reference by build output name. */
  readonly indexByFileName: Map<string, ManifestEntry>;
  /** Previous build's entries keyed by fileName, used for content-hash reuse. */
  readonly prev: Map<string, ManifestEntry>;
  /** Immutable-asset history tracker shared across builds. */
  readonly history: AssetsHistory;

  /**
   * @param prev - Manifest from the previous build (for content-hash matching).
   * @param history - History entries from the prior build cycle.
   */
  constructor(prev?: Manifest, history?: AssetsHistoryEntry[]) {
    this.entries = [];
    this.external = [];
    this.indexByURL = new Map();
    this.indexByName = new Map();
    this.indexByFileName = new Map();
    this.prev = new Map();
    this.history = new AssetsHistory(history);

    if (prev) {
      for (const entry of prev) {
        this.prev.set(entry.fileName, entry);
      }
    }
  }

  /**
   * Import an external manifest (e.g. from a dependency or separate build).
   * Entries are indexed but not added to {@link entries}.
   */
  import(manifest: Manifest) {
    this.external.push(manifest);
    for (const entry of manifest) {
      this.#indexEntry(entry);
    }
  }

  /**
   * Add a manifest entry to the current build.
   * If a previous entry with the same fileName has an identical SHA-256 hash,
   * the previous entry is reused (avoids rewriting unchanged assets).
   * Immutable assets are recorded in {@link history}.
   * @returns Index of the entry in {@link entries}.
   */
  add(entry: ManifestEntry): number {
    const flags = entry.flags;
    const prev = this.prev.get(entry.fileName);
    if (prev !== void 0) {
      if (prev.sha256 === entry.sha256) {
        entry = prev;
      }
    }
    // add to history
    if (flags & MANIFEST_ASSET_IMMUTABLE) {
      this.history.add(urlToString(entry.url), entry.sha256);
    }
    this.#indexEntry(entry);
    return this.entries.push(entry) - 1;
  }

  /**
   * Look up a previous-build entry by fileName and optionally transform it
   * before adding it to the current build. Throws if the entry doesn't exist.
   * Immutable assets are recorded in {@link history}.
   * @returns Index of the entry in {@link entries}.
   */
  updateByFileName(fileName: string, fn?: (entry: ManifestEntry) => ManifestEntry): number {
    let entry = this.prev.get(fileName);
    if (entry === void 0) {
      throw new Error(`Missing asset with a fileName '${fileName}'`);
    }
    if (fn !== void 0) {
      entry = fn(entry);
    }
    if (entry.flags & MANIFEST_ASSET_IMMUTABLE) {
      this.history.add(urlToString(entry.url), entry.sha256);
    }
    this.#indexEntry(entry);
    return this.entries.push(entry) - 1;
  }

  /** Look up an entry by its logical name. */
  getByName(name: string): ManifestEntry | undefined {
    return this.indexByName.get(name);
  }

  /** Look up an entry by its hashed filename on disk. */
  getByFileName(fileName: string): ManifestEntry | undefined {
    return this.indexByFileName.get(fileName);
  }

  /** Look up an entry by its public URL. */
  getByURL(url: string): ManifestEntry | undefined {
    return this.indexByURL.get(url);
  }

  /**
   * Register an entry in all lookup indices (URL, fileName, name).
   * Throws on duplicate fileName or duplicate name.
   */
  #indexEntry(entry: ManifestEntry) {
    if (entry.name) {
      if (Array.isArray(entry.name)) {
        for (const n of entry.name) {
          this.#indexByName(n, entry);
        }
      } else {
        this.#indexByName(entry.name, entry);
      }
    }
    if (this.indexByFileName.has(entry.fileName)) {
      throw Error(`Manifest entry with a fileName '${entry.fileName}' already exists`);
    }
    this.indexByFileName.set(entry.fileName, entry);
    this.indexByURL.set(urlToString(entry.url), entry);
  }

  /** Register a single logical name → entry mapping. Throws on collision. */
  #indexByName(name: string, entry: ManifestEntry) {
    if (this.indexByName.has(name)) {
      throw Error(`Manifest entry with a name '${name}' already exists`);
    }
    this.indexByName.set(name, entry);
  }
}

function urlToString(url: string | { origin: string; path: string }): string {
  if (typeof url === 'string') {
    return url;
  }
  return url.origin + url.path;
}
