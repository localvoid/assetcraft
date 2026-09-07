import * as fs from 'node:fs/promises';

import type { Manifest } from '../manifest.js';
import type { PendingRemoval } from './files.js';
import type { DeployHistoryEntry } from './history.js';
import { updateFile } from '../file.js';
import { parseManifest } from '../manifest/validate.js';
import { checkManifest } from './history.js';

/** Deploy metadata persisted between cycles in a single sidecar file. */
export interface DeployState {
  /** Immutable-asset URL-to-hash mappings (see `./history.js`). */
  readonly history: DeployHistoryEntry[];
  /** Removed files awaiting deletion grace (see `./files.js`). */
  readonly pending: PendingRemoval[];
}

/** Empty deploy state for the first deploy. */
export function emptyDeployState(): DeployState {
  return { history: [], pending: [] };
}

/**
 * Conventional deploy-state path for a manifest: `<manifest>.deploy.json`.
 * An explicit `override` wins (useful for shared CI-artifact locations).
 */
export function deriveDeployPath(manifestPath: string, override?: string): string {
  if (override !== void 0) {
    return override;
  }
  if (manifestPath.toLowerCase().endsWith('.json')) {
    return `${manifestPath.slice(0, -5)}.deploy.json`;
  }
  return `${manifestPath}.deploy.json`;
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse serialized deploy state. Accepts a full `{ history, pending }`
 * object; missing keys default to `[]` (forward-compatible).
 * @throws On invalid payloads.
 */
export function parseDeployState(data: string): DeployState {
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
  };
}

function parseHistoryEntries(value: unknown): DeployHistoryEntry[] {
  if (value === void 0) {
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
      (entry['removedAt'] !== void 0 &&
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
  if (value === void 0) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid deploy state: pending must be an array');
  }
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
  }
  return value as PendingRemoval[];
}

/**
 * Load deploy state. Returns `undefined` when the file is missing
 * (first deploy). A corrupt file throws: silently dropping history
 * would allow immutable URL reuse (cache collisions).
 */
export async function loadDeployState(path: string): Promise<DeployState | undefined> {
  try {
    return parseDeployState(await fs.readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return void 0;
    }
    throw err;
  }
}

/**
 * Write deploy state, creating parent directories. Skips the write when
 * content is unchanged (no timestamp churn).
 */
export async function saveDeployState(path: string, state: DeployState): Promise<void> {
  await updateFile(path, JSON.stringify(state, void 0, 2));
}

export interface DeployCheck {
  readonly manifest: Manifest;
  readonly state: DeployState | undefined;
}

/**
 * Load a manifest and its deploy-state file, then run the history
 * collision check.
 * @throws On missing/invalid manifest, corrupt state, or URL reuse
 * with different content.
 */
export async function checkDeploy(manifestPath: string, deployPath?: string): Promise<DeployCheck> {
  let manifest: Manifest;
  try {
    manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Invalid manifest '${manifestPath}': file not found`);
    }
    throw new Error(
      `Invalid manifest '${manifestPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let state: DeployState | undefined;
  if (deployPath !== void 0) {
    try {
      state = await loadDeployState(deployPath);
    } catch (err) {
      throw new Error(
        `Invalid deploy state '${deployPath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  checkManifest(manifest, state?.history);
  return { manifest, state };
}
