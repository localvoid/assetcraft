import { createHash, hash } from 'node:crypto';
import { extname } from 'node:path';

import type { Manifest, ManifestEntry, ManifestEntryType } from '../manifest.js';
import { MANIFEST_VERSION, urlToString } from '../manifest.js';

/**
 * ManifestBuilder — accumulates manifest entries during a build and
 * maintains lookup indices.
 */
export class ManifestBuilder {
  #entries: ManifestEntry[] = [];
  #external: (readonly ManifestEntry[])[] = [];
  #indexByURL = new Map<string, ManifestEntry>();
  #indexByName = new Map<string, ManifestEntry>();
  #indexByPath = new Map<string, ManifestEntry>();
  #externalByURL = new Map<string, ManifestEntry>();
  #externalByName = new Map<string, ManifestEntry>();
  #externalByPath = new Map<string, ManifestEntry>();
  #prev = new Map<string, ManifestEntry>();

  /** All entries added to this build, in insertion order (live view). */
  get entries(): readonly ManifestEntry[] {
    return this.#entries;
  }

  /** This build as a versioned manifest (snapshot copy of {@link entries}). */
  toManifest(): Manifest {
    return { version: MANIFEST_VERSION, entries: [...this.#entries] };
  }

  /**
   * @param prev - Manifest from the previous build (for content-hash matching).
   */
  constructor(prev?: Manifest) {
    if (prev) {
      for (const entry of prev.entries) {
        this.#prev.set(entry.path, entry);
      }
    }
  }

  /**
   * Import an external manifest (e.g. from a dependency or separate build).
   * Entries are indexed for lookup, but not added to {@link entries}. Local
   * entries added via {@link add} shadow external ones with the same key.
   * Throws on duplicate path, name, or conflicting URL within external
   * manifests.
   */
  import(manifest: Manifest) {
    this.#external.push(manifest.entries);
    for (const entry of manifest.entries) {
      this.#indexExternal(entry);
    }
  }

  /**
   * Add a manifest entry to the current build.
   * @returns Index of the entry in {@link entries}.
   */
  add(entry: ManifestEntry): number {
    this.#indexLocal(entry);
    return this.#entries.push(entry) - 1;
  }

  /**
   * Add a manifest entry to the current build, or replace the existing
   * entry with the same path. Replacement keeps the original position in
   * {@link entries}. Name and URL collisions with *other* entries throw,
   * leaving the existing entry untouched.
   * @returns Index of the entry in {@link entries}.
   */
  upsert(entry: ManifestEntry): number {
    const existing = this.#indexByPath.get(entry.path);
    if (existing === void 0) {
      return this.add(entry);
    }
    if (existing === entry) {
      return this.#entries.indexOf(entry);
    }
    this.#assertLocalAvailable(entry, existing);
    this.#unindexLocal(existing);
    this.#indexLocal(entry);
    const pos = this.#entries.indexOf(existing);
    if (pos === -1) {
      return this.#entries.push(entry) - 1;
    }
    this.#entries[pos] = entry;
    return pos;
  }

  /**
   * Look up a previous-build entry by path and optionally transform it
   * before adding it to the current build. Throws if the entry doesn't exist.
   * @returns Index of the entry in {@link entries}.
   */
  updateByPath(path: string, fn?: (entry: ManifestEntry) => ManifestEntry): number {
    let entry = this.#prev.get(path);
    if (entry === void 0) {
      throw new Error(`Missing asset '${path}'`);
    }
    if (fn !== void 0) {
      entry = fn(entry);
    }
    this.#indexLocal(entry);
    return this.#entries.push(entry) - 1;
  }

  /** Look up an entry by its logical name (local entries take precedence). */
  getByName(name: string): ManifestEntry | undefined {
    return this.#indexByName.get(name) ?? this.#externalByName.get(name);
  }

  /** Look up an entry by its hashed path on disk (local entries take precedence). */
  getByPath(path: string): ManifestEntry | undefined {
    return this.#indexByPath.get(path) ?? this.#externalByPath.get(path);
  }

  /** Look up an entry by its public URL (local entries take precedence). */
  getByURL(url: string): ManifestEntry | undefined {
    return this.#indexByURL.get(url) ?? this.#externalByURL.get(url);
  }

  /**
   * List all entries tagged with `tag`, in build order followed by
   * external manifests. Local entries shadow external ones with the
   * same path.
   */
  getByTag(tag: string): ManifestEntry[] {
    const result: ManifestEntry[] = [];
    for (const entry of this.#entries) {
      if (entry.tags?.includes(tag)) {
        result.push(entry);
      }
    }
    for (const entry of this.#unshadowedExternal()) {
      if (entry.tags?.includes(tag)) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * List all entries of a given type, in build order followed by
   * external manifests. Local entries shadow external ones with the
   * same path.
   */
  listByType(type: ManifestEntryType): ManifestEntry[] {
    const result: ManifestEntry[] = [];
    for (const entry of this.#entries) {
      if (entry.type === type) {
        result.push(entry);
      }
    }
    for (const entry of this.#unshadowedExternal()) {
      if (entry.type === type) {
        result.push(entry);
      }
    }
    return result;
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
    if (this.#indexByPath.has(entry.path)) {
      throw Error(`Manifest entry with a path '${entry.path}' already exists`);
    }
    this.#indexByPath.set(entry.path, entry);
    this.#indexLocalByURL(entry);
  }

  /** Register a single logical name → entry mapping. Throws on collision. */
  #indexLocalByName(name: string, entry: ManifestEntry) {
    if (this.#indexByName.has(name)) {
      throw Error(`Manifest entry with a name '${name}' already exists`);
    }
    this.#indexByName.set(name, entry);
  }

  /**
   * Check that `entry` can be indexed without colliding with entries
   * other than `ignore`. Used by {@link upsert} to fail before mutating
   * any index, leaving the existing entry untouched on error.
   */
  #assertLocalAvailable(entry: ManifestEntry, ignore: ManifestEntry) {
    if (entry.name !== undefined) {
      const names = Array.isArray(entry.name) ? entry.name : [entry.name];
      for (const n of names) {
        const mapped = this.#indexByName.get(n);
        if (mapped !== undefined && mapped !== ignore) {
          throw Error(`Manifest entry with a name '${n}' already exists`);
        }
      }
    }
    const url = urlToString(entry.url);
    const mapped = this.#indexByURL.get(url);
    if (mapped !== undefined && mapped !== ignore && mapped.sha256 !== entry.sha256) {
      throw Error(`Manifest entry with a url '${url}' already exists with a different hash`);
    }
  }

  /** Remove an entry from all local lookup indices (guarded by identity). */
  #unindexLocal(entry: ManifestEntry) {
    if (entry.name !== undefined) {
      const names = Array.isArray(entry.name) ? entry.name : [entry.name];
      for (const n of names) {
        if (this.#indexByName.get(n) === entry) {
          this.#indexByName.delete(n);
        }
      }
    }
    if (this.#indexByPath.get(entry.path) === entry) {
      this.#indexByPath.delete(entry.path);
    }
    const url = urlToString(entry.url);
    if (this.#indexByURL.get(url) === entry) {
      this.#indexByURL.delete(url);
    }
  }

  /** All external entries not shadowed by a local entry with the same path. */
  #unshadowedExternal(): ManifestEntry[] {
    const result: ManifestEntry[] = [];
    for (const manifest of this.#external) {
      for (const entry of manifest) {
        if (!this.#indexByPath.has(entry.path)) {
          result.push(entry);
        }
      }
    }
    return result;
  }

  /**
   * Register a URL → entry mapping. Throws if the URL is already taken
   * by different content; same-content duplicates are idempotent.
   */
  #indexLocalByURL(entry: ManifestEntry) {
    const url = urlToString(entry.url);
    const existing = this.#indexByURL.get(url);
    if (existing !== void 0 && existing !== entry && existing.sha256 !== entry.sha256) {
      throw Error(`Manifest entry with a url '${url}' already exists with a different hash`);
    }
    this.#indexByURL.set(url, entry);
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
          if (this.#externalByName.has(n)) {
            throw Error(`Manifest entry with a name '${n}' already exists`);
          }
          this.#externalByName.set(n, entry);
        }
      } else {
        if (this.#externalByName.has(entry.name)) {
          throw Error(`Manifest entry with a name '${entry.name}' already exists`);
        }
        this.#externalByName.set(entry.name, entry);
      }
    }
    if (this.#externalByPath.has(entry.path)) {
      throw Error(`Manifest entry with a path '${entry.path}' already exists`);
    }
    this.#externalByPath.set(entry.path, entry);
    const url = urlToString(entry.url);
    const existing = this.#externalByURL.get(url);
    if (existing !== void 0 && existing !== entry && existing.sha256 !== entry.sha256) {
      throw Error(`Manifest entry with a url '${url}' already exists with a different hash`);
    }
    this.#externalByURL.set(url, entry);
  }
}

/** Compute a URL-safe SHA-256 hash of the given content. */
export function urlSafeSHA256(code: string | Uint8Array): string {
  return hash('sha256', code, 'base64url');
}

/** Hash algorithm for the Subresource Integrity string. */
export type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512';

/** Concrete entry type for a discriminant. */
export type ManifestEntryFor<T extends ManifestEntryType> = Extract<ManifestEntry, { type: T }>;

/** Compute an SRI string (`"<algo>-<base64>"`) for `content`. */
export function computeIntegrity(content: Uint8Array, algorithm: IntegrityAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`;
}

/** Options for {@link createPathFormatter}. */
export interface CreatePathFormatterOptions {
  /**
   * Output directory for the formatted path. When defined, it replaces
   * the directory portion of `entry.path` (`''` puts the file at the
   * root). Defaults to the directory of `entry.path`.
   */
  readonly dir?: string;
  /**
   * Number of leading hash characters inserted before the extension.
   * Defaults to 12. `0` inserts no hash (applies only the `dir` remap).
   */
  readonly hash?: number;
}

/** Formats an output path from an entry template and its content hash. */
export type PathFormatter = (entry: ManifestEntry, sha256: string) => string;

/**
 * Create a path formatter that inserts a hash prefix before the
 * extension (`app.js` → `app-<hash>.js`). Only `entry.path` is read
 * from the entry, so a `{ path }` stub can be passed before the entry
 * exists. Format the path first, then use it in the manifest entry.
 *
 * ```ts
 * const formatPath = createPathFormatter({ dir: 'assets', hash: 8 });
 * const path = formatPath({ path: 'src/app.js' } as ManifestEntry, sha256);
 * // → 'assets/app-<8-char-hash>.js'
 * ```
 */
export function createPathFormatter(options?: CreatePathFormatterOptions): PathFormatter {
  const dir = options?.dir;
  const hashLength = options?.hash ?? 12;
  return (entry, sha256) => {
    const ext = extname(entry.path);
    const base = ext === '' ? entry.path : entry.path.slice(0, -ext.length);
    const slash = base.lastIndexOf('/');
    const name = slash === -1 ? base : base.slice(slash + 1);
    const file = hashLength > 0 ? `${name}-${sha256.slice(0, hashLength)}${ext}` : `${name}${ext}`;
    if (dir !== undefined) {
      const trimmed = dir.replace(/\/+$/, '');
      return trimmed === '' ? file : `${trimmed}/${file}`;
    }
    return slash === -1 ? file : `${base.slice(0, slash + 1)}${file}`;
  };
}
