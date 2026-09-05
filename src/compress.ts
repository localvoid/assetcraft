/**
 * Compression utilities for generating Brotli, Zstandard, and gzip
 * variants of static assets. Each format is tried independently and
 * only included in the result if the compressed size meets the minimum
 * savings threshold.
 */

import { promisify } from 'node:util';
import {
  brotliCompress,
  brotliCompressSync,
  constants,
  gzip,
  gzipSync,
  zstdCompress,
  zstdCompressSync,
  type BrotliOptions,
  type ZlibOptions,
  type ZstdOptions,
} from 'node:zlib';

/** Compress asset options. */
export interface CompressAssetOptions {
  /** Minimum uncompressed size (bytes) before compression is attempted. */
  readonly sizeMin?: number;
  /** Minimum compression ratio (0–1) to keep a variant. E.g. 0.1 = 10% savings. */
  readonly sizeMinDiffRatio?: number;
  /** Brotli options, merged over the defaults. */
  readonly br?: BrotliOptions;
  /** Zstandard options, merged over the defaults. */
  readonly zstd?: ZstdOptions;
  /** Gzip options, merged over the defaults. */
  readonly gzip?: ZlibOptions;
}

/** Compression format identifiers. These match HTTP `Content-Encoding` values. */
export type CompressFormat = 'br' | 'zstd' | 'gzip';

/** Compressed variants of an asset. Only populated with variants that meet the savings threshold. */
export type CompressAssetResult = {
  readonly [format in CompressFormat]?: Buffer;
};

/**
 * Synchronously compress `content` and return the variants that meet
 * the minimum savings threshold.
 */
export function compressAssetSync(
  content: Uint8Array | string,
  options?: CompressAssetOptions,
): CompressAssetResult {
  const {
    sizeMin = 512,
    sizeMinDiffRatio = 0.1,
    br: brOptions,
    zstd: zstdOptions,
    gzip: gzipOptions,
  } = options ?? {};

  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const size = buf.length;
  const result: { -readonly [format in CompressFormat]?: Buffer } = {};
  if (size < sizeMin) {
    return result;
  }
  // Threshold: only keep a variant if it saves at least `sizeMinDiffRatio` ratio.
  const sizeThreshold = size * (1 - sizeMinDiffRatio);

  const br = brotliCompressSync(buf, resolveBrotliOptions(size, brOptions));
  if (br.length < sizeThreshold) {
    result.br = br;
  }

  const zstd = zstdCompressSync(buf, resolveZstdOptions(zstdOptions));
  if (zstd.length < sizeThreshold) {
    result.zstd = zstd;
  }

  const gz = gzipSync(buf, resolveGzipOptions(gzipOptions));
  if (gz.length < sizeThreshold) {
    result.gzip = gz;
  }

  return result;
}

const brotliCompressAsync = promisify(brotliCompress) as (
  buf: Uint8Array | string,
  options: BrotliOptions,
) => Promise<Buffer>;
const zstdCompressAsync = promisify(zstdCompress) as (
  buf: Uint8Array | string,
  options: ZstdOptions,
) => Promise<Buffer>;
const gzipAsync = promisify(gzip) as (
  buf: Uint8Array | string,
  options: ZlibOptions,
) => Promise<Buffer>;

/**
 * Asynchronously compress `content` and return the variants that meet
 * the minimum savings threshold. All formats are compressed in parallel.
 */
export async function compressAsset(
  content: Uint8Array | string,
  options?: CompressAssetOptions,
): Promise<CompressAssetResult> {
  const {
    sizeMin = 512,
    sizeMinDiffRatio = 0.1,
    br: brOptions,
    zstd: zstdOptions,
    gzip: gzipOptions,
  } = options ?? {};

  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const size = buf.length;
  const result: { -readonly [format in CompressFormat]?: Buffer } = {};
  if (size < sizeMin) {
    return result;
  }
  // Threshold: only keep a variant if it saves at least `sizeMinDiffRatio` ratio.
  const sizeThreshold = size * (1 - sizeMinDiffRatio);

  const [br, zstd, gz] = await Promise.all([
    brotliCompressAsync(buf, resolveBrotliOptions(size, brOptions)),
    zstdCompressAsync(buf, resolveZstdOptions(zstdOptions)),
    gzipAsync(buf, resolveGzipOptions(gzipOptions)),
  ]);

  if (br.length < sizeThreshold) {
    result.br = br;
  }
  if (zstd.length < sizeThreshold) {
    result.zstd = zstd;
  }
  if (gz.length < sizeThreshold) {
    result.gzip = gz;
  }

  return result;
}

function resolveBrotliOptions(size: number, overrides?: BrotliOptions): BrotliOptions {
  return {
    ...overrides,
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
      ...overrides?.params,
    },
  };
}

function resolveZstdOptions(overrides?: ZstdOptions): ZstdOptions {
  return {
    ...overrides,
    params: {
      [constants.ZSTD_c_compressionLevel]: 22,
      [constants.ZSTD_c_strategy]: constants.ZSTD_btultra2,
      ...overrides?.params,
    },
  };
}

function resolveGzipOptions(overrides?: ZlibOptions): ZlibOptions {
  return {
    level: constants.Z_BEST_COMPRESSION,
    ...overrides,
  };
}
