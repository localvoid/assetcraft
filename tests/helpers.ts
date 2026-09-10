/**
 * Shared fixtures for filesystem tests.
 */

import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Check whether `path` exists (file, directory, or symlink). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write `files` (relative path → content) under `dir`, creating parents. */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}
