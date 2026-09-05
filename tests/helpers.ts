/**
 * Shared fixtures for filesystem tests. Each helper creates real temporary
 * directories and always cleans them up, so failed assertions never leak
 * state into other tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

/** Create a fresh temporary directory. */
export async function makeTempDir(prefix = 'assetcraft-test-'): Promise<string> {
  return fs.mkdtemp(join(os.tmpdir(), prefix));
}

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

/**
 * Run `fn` with a fresh temporary directory, removing it afterwards even
 * when `fn` throws.
 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
