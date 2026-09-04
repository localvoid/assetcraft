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
  /** File path → entry index for dedup and reference by build output name. */
  readonly indexByPath: Map<string, ManifestEntry>;
  /**
   * Lookup indices for imported external manifests. Local entries
   * ({@link indexByURL}, {@link indexByName}, {@link indexByPath}) take
   * precedence; the getters fall through to these maps on a local miss.
   */
  readonly externalByURL: Map<string, ManifestEntry>;
  /** Logical name → external entry index (shadowed by local entries). */
  readonly externalByName: Map<string, ManifestEntry>;
  /** File path → external entry index (shadowed by local entries). */
  readonly externalByPath: Map<string, ManifestEntry>;
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
    this.indexByPath = new Map();
    this.externalByURL = new Map();
    this.externalByName = new Map();
    this.externalByPath = new Map();
    this.prev = new Map();
    this.history = new AssetsHistory(history);

    if (prev) {
      for (const entry of prev) {
        this.prev.set(entry.path, entry);
      }
    }
  }

  /**
   * Import an external manifest (e.g. from a dependency or separate build).
   * Entries are indexed in {@link externalByURL}, {@link externalByName},
   * and {@link externalByPath}, but not added to {@link entries}. Local
   * entries added via {@link add} shadow external ones with the same key.
   * Throws on duplicate path, name, or conflicting URL within external
   * manifests.
   */
  import(manifest: Manifest) {
    this.external.push(manifest);
    for (const entry of manifest) {
      this.#indexExternal(entry);
    }
  }

  /**
   * Add a manifest entry to the current build.
   * Immutable assets are recorded in {@link history}.
   * @returns Index of the entry in {@link entries}.
   */
  add(entry: ManifestEntry): number {
    // add to history
    if (entry.flags & MANIFEST_ASSET_IMMUTABLE) {
      this.history.add(urlToString(entry.url), entry.sha256);
    }
    this.#indexLocal(entry);
    return this.entries.push(entry) - 1;
  }

  /**
   * Look up a previous-build entry by path and optionally transform it
   * before adding it to the current build. Throws if the entry doesn't exist.
   * Immutable assets are recorded in {@link history}.
   * @returns Index of the entry in {@link entries}.
   */
  updateByPath(path: string, fn?: (entry: ManifestEntry) => ManifestEntry): number {
    let entry = this.prev.get(path);
    if (entry === void 0) {
      throw new Error(`Missing asset '${path}'`);
    }
    if (fn !== void 0) {
      entry = fn(entry);
    }
    if (entry.flags & MANIFEST_ASSET_IMMUTABLE) {
      this.history.add(urlToString(entry.url), entry.sha256);
    }
    this.#indexLocal(entry);
    return this.entries.push(entry) - 1;
  }

  /** Look up an entry by its logical name (local entries take precedence). */
  getByName(name: string): ManifestEntry | undefined {
    return this.indexByName.get(name) ?? this.externalByName.get(name);
  }

  /** Look up an entry by its hashed path on disk (local entries take precedence). */
  getByPath(path: string): ManifestEntry | undefined {
    return this.indexByPath.get(path) ?? this.externalByPath.get(path);
  }

  /** Look up an entry by its public URL (local entries take precedence). */
  getByURL(url: string): ManifestEntry | undefined {
    return this.indexByURL.get(url) ?? this.externalByURL.get(url);
  }

  /**
   * Register a current-build entry in all local lookup indices
   * (URL, path, name). Throws on duplicate path, duplicate name,
   * or URL conflict with different content.
   */
  #indexLocal(entry: ManifestEntry) {
    if (entry.name) {
      if (Array.isArray(entry.name)) {
        for (const n of entry.name) {
          this.#indexLocalByName(n, entry);
        }
      } else {
        this.#indexLocalByName(entry.name, entry);
      }
    }
    if (this.indexByPath.has(entry.path)) {
      throw Error(`Manifest entry with a path '${entry.path}' already exists`);
    }
    this.indexByPath.set(entry.path, entry);
    this.#indexLocalByURL(entry);
  }

  /** Register a single logical name → entry mapping. Throws on collision. */
  #indexLocalByName(name: string, entry: ManifestEntry) {
    if (this.indexByName.has(name)) {
      throw Error(`Manifest entry with a name '${name}' already exists`);
    }
    this.indexByName.set(name, entry);
  }

  /**
   * Register a URL → entry mapping. Throws if the URL is already taken
   * by different content; same-content duplicates are idempotent.
   */
  #indexLocalByURL(entry: ManifestEntry) {
    const url = urlToString(entry.url);
    const existing = this.indexByURL.get(url);
    if (existing !== void 0 && existing !== entry && existing.sha256 !== entry.sha256) {
      throw Error(`Manifest entry with a url '${url}' already exists with a different hash`);
    }
    this.indexByURL.set(url, entry);
  }

  /**
   * Register an external entry in the external lookup indices.
   * Throws on duplicate path, duplicate name, or URL conflict with
   * different content within external manifests.
   */
  #indexExternal(entry: ManifestEntry) {
    if (entry.name) {
      if (Array.isArray(entry.name)) {
        for (const n of entry.name) {
          if (this.externalByName.has(n)) {
            throw Error(`Manifest entry with a name '${n}' already exists`);
          }
          this.externalByName.set(n, entry);
        }
      } else {
        if (this.externalByName.has(entry.name)) {
          throw Error(`Manifest entry with a name '${entry.name}' already exists`);
        }
        this.externalByName.set(entry.name, entry);
      }
    }
    if (this.externalByPath.has(entry.path)) {
      throw Error(`Manifest entry with a path '${entry.path}' already exists`);
    }
    this.externalByPath.set(entry.path, entry);
    const url = urlToString(entry.url);
    const existing = this.externalByURL.get(url);
    if (existing !== void 0 && existing !== entry && existing.sha256 !== entry.sha256) {
      throw Error(`Manifest entry with a url '${url}' already exists with a different hash`);
    }
    this.externalByURL.set(url, entry);
  }
}

function urlToString(url: string | { origin: string; path: string }): string {
  if (typeof url === 'string') {
    return url;
  }
  return url.origin + url.path;
}
