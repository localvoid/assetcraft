/**
 * File-system utilities for reading, writing, and cleaning build output
 * directories. Used internally by the manifest builder pipeline.
 */

import { hash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

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
  } catch {}

  await fs.writeFile(path, content);
  return true;
}

/**
 * Remove all files in `dir`, optionally skipping entries in `ignore`.
 * Non-recursive: only top-level files are deleted.
 */
export async function cleanDir(dir: string, ignore?: Set<string>): Promise<void> {
  for (const file of await fs.readdir(dir, { withFileTypes: true })) {
    if (file.isFile()) {
      if (ignore?.has(file.name)) {
        continue;
      }
      await fs.rm(resolve(dir, file.name));
    }
  }
}

/**
 * Regex that splits a relative path into its first directory segment and
 * the remainder (e.g. "a/b/c" → ["a", "b/c"]).
 */
const SPLIT_FIRST_DIR_RE = /(.+?)[\\/](.+)/;

/**
 * Recursively remove files from `dir`, respecting a list of paths to keep.
 * Paths in `ignore` can be nested (e.g. "sub/dir/file.txt") — the
 * function walks into subdirectories only when needed.
 */
export async function cleanDirRecursive(dir: string, ignore?: string[]): Promise<void> {
  const skipInDir = new Set<string>();
  let nested: Map<string, string[]> | null = null;
  if (ignore?.length) {
    for (const file of ignore) {
      if (dirname(file) !== '.') {
        const matched = SPLIT_FIRST_DIR_RE.exec(file);
        if (matched) {
          nested ??= new Map();
          const [, nestedDir, skipPath] = matched;
          let nestedSkip = nested.get(nestedDir);
          if (!nestedSkip) {
            nestedSkip = [];
            nested.set(nestedDir, nestedSkip);
          }
          if (!nestedSkip.includes(skipPath)) {
            nestedSkip.push(skipPath);
          }
        }
      } else {
        skipInDir.add(file);
      }
    }
  }
  for (const file of await fs.readdir(dir)) {
    if (skipInDir.has(file)) {
      continue;
    }
    if (nested?.has(file)) {
      await cleanDirRecursive(resolve(dir, file), nested.get(file));
    } else {
      await fs.rm(resolve(dir, file), RECURSIVE_FORCE);
    }
  }
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
  return resolve(path).startsWith(resolve(parent));
}

/** Format a byte count into a human-readable string (B, KB, MB). */
export function formatFileSize(i: number): string {
  if (i < 1024) {
    return `${i}B`;
  }
  i /= 1024;
  if (i < 1024) {
    return `${i.toFixed(2)}KB`;
  }
  i /= 1024;
  return `${i.toFixed(2)}MB`;
}

const RECURSIVE = { recursive: true };
const RECURSIVE_FORCE = { recursive: true, force: true };
const TEXT_ENCODER = new TextEncoder();
