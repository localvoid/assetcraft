/**
 * File-system utilities for reading, writing, and cleaning build output
 * directories. Used internally by the manifest builder pipeline.
 */

import { hash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';

/** Compute a URL-safe SHA-256 hash of the given content. */
export function calculateHash(code: string | Uint8Array): string {
  return hash('sha256', code, 'base64url');
}

/**
 * Generate a content-hashed filename.
 * Example: `style.css` + hash → `style-a1b2c3d4e5f6.css`
 */
export function uniqueFileName(name: string, hash: string): string {
  hash = hash.slice(0, 12);
  const ext = extname(name);
  if (ext === '') {
    return `${name}-${hash}`;
  }
  return name.slice(0, -ext.length) + '-' + hash + ext;
}

/**
 * Write content to `path` only if it differs from the existing file.
 * This avoids unnecessary rebuilds triggered by timestamp changes.
 * @param mkdir - Create parent directories if they don't exist (default true).
 * @returns `true` if the file was written, `false` if unchanged.
 */
export async function updateFile(
  path: string,
  content: string | Uint8Array,
  mkdir = true,
): Promise<boolean> {
  if (mkdir) {
    await fs.mkdir(dirname(path), RECURSIVE);
  }
  try {
    const c = await fs.readFile(path);
    if (typeof content === 'string') {
      content = TEXT_ENCODER.encode(content);
    }
    if (c.equals(content)) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.writeFile(path, content);
  return true;
}

/**
 * Remove all files in `dir`, optionally skipping entries in `ignore`.
 * Non-recursive: only top-level files are deleted.
 * Symbolic links are removed themselves (never followed).
 * @throws If `dir` doesn't exist or isn't readable.
 */
export async function cleanDir(dir: string, ignore?: Set<string>): Promise<void> {
  for (const file of await fs.readdir(dir, { withFileTypes: true })) {
    if (file.isFile() || file.isSymbolicLink()) {
      if (ignore?.has(file.name)) {
        continue;
      }
      await fs.rm(resolve(dir, file.name));
    }
  }
}

/**
 * Options for {@link cleanDirRecursive}.
 */
export interface CleanDirRecursiveOptions {
  /**
   * Remove directories that become empty after pruning (default `false`).
   * The root `dir` itself is never removed, and directories that exactly
   * match an `ignore` entry are never removed.
   */
  readonly removeEmptyDirs?: boolean;
}

/**
 * Recursively remove files from `dir`, respecting a list of paths to keep.
 * Paths in `ignore` must be normalized relative paths using `/` separators
 * (e.g. "sub/dir/file.txt") — the function walks into subdirectories only
 * when needed. A trailing `/` (e.g. "sub/") keeps the whole subtree.
 * An `ignore` entry that exactly matches a name keeps whatever is at that
 * name (file, symlink, or entire directory tree). A nested entry
 * (e.g. "sub/keep.txt") only descends into `sub` when it is a real
 * directory; a file or symlink at `sub` is stale and is removed.
 * Anything else (empty, absolute, or starting with `.`/`..`) never matches.
 * Symbolic links are removed themselves (never followed).
 * @throws If `dir` doesn't exist or isn't readable.
 */
export async function cleanDirRecursive(
  dir: string,
  ignore?: string[],
  options?: CleanDirRecursiveOptions,
): Promise<void> {
  await cleanTree(dir, ignore?.length ? buildKeepTree(ignore) : null, options);
}

/** A node in the keep-trie built from `ignore` paths. */
interface KeepNode {
  /**
   * An entry ends here: keep whatever is at this name (file, symlink, or
   * entire directory tree) without descending further.
   */
  keepWhole: boolean;
  /** Keeps nested below this name, keyed by the next segment. */
  children: Map<string, KeepNode>;
}

/**
 * Build a keep-trie from `ignore` paths, splitting each path into segments
 * only once. Entries that can never match (empty, absolute, or escaping
 * with `..`) are dropped.
 */
function buildKeepTree(ignore: string[]): Map<string, KeepNode> {
  const root = new Map<string, KeepNode>();
  for (const file of ignore) {
    const segments = splitKeepSegments(file);
    if (segments === null) {
      continue;
    }
    let level = root;
    for (let i = 0; i < segments.length; i++) {
      let node = level.get(segments[i]);
      if (!node) {
        node = { keepWhole: false, children: new Map() };
        level.set(segments[i], node);
      }
      if (i === segments.length - 1) {
        node.keepWhole = true;
      } else if (node.keepWhole) {
        // An ancestor already keeps the whole subtree; deeper segments
        // are redundant.
        break;
      }
      level = node.children;
    }
  }
  return root;
}

/**
 * Clean `dir`, keeping whatever `keep` describes.
 * @returns `true` when `dir` holds no entries afterwards.
 */
async function cleanTree(
  dir: string,
  keep: Map<string, KeepNode> | null,
  options?: CleanDirRecursiveOptions,
): Promise<boolean> {
  let empty = true;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    const child = join(dir, name);
    const node = keep?.get(name);
    if (node === undefined) {
      await fs.rm(child, RECURSIVE_FORCE);
      continue;
    }
    if (node.keepWhole) {
      empty = false;
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      // A file or symlink blocks a nested keep path, so it is stale.
      await fs.rm(child, RECURSIVE_FORCE);
      continue;
    }
    if ((await cleanTree(child, node.children, options)) && options?.removeEmptyDirs === true) {
      await fs.rmdir(child);
    } else {
      empty = false;
    }
  }
  return empty;
}

/**
 * Why a relative path is unusable as a keep path: empty input (`empty`),
 * an absolute path (`absolute`), the directory itself (`.`, `empty` after
 * normalization, e.g. `a/..`; `self`), or something escaping it
 * (`..`, `../x`; `escape`).
 */
export type InvalidKeepPathReason = 'empty' | 'absolute' | 'self' | 'escape';

/**
 * Normalize an output-relative keep path to a canonical posix form.
 * Accepts `./`, duplicate `/`, and `inner/../` segments; `\` is treated as
 * a separator on Windows only (on posix it is a valid filename character).
 * A trailing `/` is stripped (keeping `sub/` as `sub`).
 * Pure: no filesystem access, no throwing — inspect `reason` instead.
 */
export function normalizeRelativePath(
  path: string,
): { ok: true; path: string } | { ok: false; reason: InvalidKeepPathReason } {
  if (path === '') {
    return { ok: false, reason: 'empty' };
  }
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path)) {
    return { ok: false, reason: 'absolute' };
  }
  const normalized = posix.normalize(sep === '/' ? path : path.replace(/\\/g, '/'));
  const stripped = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (stripped === '.' || stripped === '') {
    return { ok: false, reason: 'self' };
  }
  if (stripped === '..' || stripped.startsWith('../') || stripped.startsWith('/')) {
    return { ok: false, reason: 'escape' };
  }
  return { ok: true, path: stripped };
}

/**
 * Split a keep path into segments (e.g. "a/b/c" → ["a", "b", "c"]).
 * Returns `null` for entries that can never match a directory entry
 * (empty, absolute, self-referencing, or escaping with `..`).
 */
function splitKeepSegments(path: string): string[] | null {
  const normalized = normalizeRelativePath(path);
  if (!normalized.ok) {
    return null;
  }
  return normalized.path.split('/');
}

/** Ensure `path` ends with a trailing slash. */
export function pathWithTrailingSlash(path: string): string {
  if (path[path.length - 1] !== '/') {
    return `${path}/`;
  }
  return path;
}

/** Check whether `path` is located within `parent` (resolved absolute). */
export function pathIsWithin(parent: string, path: string): boolean {
  const p = resolve(parent);
  const r = resolve(path);
  return r === p || r.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Format a byte count into a human-readable string (B, KB, MB, GB, TB, PB). */
export function formatFileSize(i: number): string {
  if (i < 1024) {
    return `${i}B`;
  }
  i /= 1024;
  if (i < 1024) {
    return `${i.toFixed(2)}KB`;
  }
  i /= 1024;
  if (i < 1024) {
    return `${i.toFixed(2)}MB`;
  }
  i /= 1024;
  return `${i.toFixed(2)}GB`;
}

const RECURSIVE = { recursive: true };
const RECURSIVE_FORCE = { recursive: true, force: true };
const TEXT_ENCODER = new TextEncoder();
