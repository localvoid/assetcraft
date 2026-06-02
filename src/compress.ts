/**
 * Compression utilities for generating Brotli, Zstandard, and gzip
 * variants of static assets. Each format is tried independently and
 * only yielded if the compressed size meets the minimum savings threshold.
 */

import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from 'node:zlib';

/** Compress asset options. */
export interface CompressAssetOptions {
  /** Minimum uncompressed size (bytes) before compression is attempted. */
  readonly sizeMin?: number;
  /** Minimum compression ratio (0–1) to keep a variant. E.g. 0.1 = 10% savings. */
  readonly sizeMinDiffRatio?: number;
}

/** A single compressed variant of an asset. */
export interface CompressEntry {
  readonly format: 'gzip' | 'brotli' | 'zstd';
  readonly content: Buffer;
}

/**
 * Generator that yields compressed {@link CompressEntry} variants.
 */
export function* compressAsset(
  content: Uint8Array | string,
  options?: CompressAssetOptions,
): Generator<CompressEntry, undefined, void> {
  const { sizeMin = 512, sizeMinDiffRatio = 0.1 } = options ?? {};

  if (typeof content === 'string') {
    content = Buffer.from(content);
  }
  const size = content.length;
  if (size < sizeMin) {
    return;
  }
  // Threshold: only keep a variant if it saves at least `sizeDiff` ratio.
  const sizeThreshold = size * (1 - sizeMinDiffRatio);

  const brotli = brotliCompressSync(content, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  });
  if (brotli.length < sizeThreshold) {
    yield { format: 'brotli', content: brotli };
  }

  const zstd = zstdCompressSync(content, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 22,
      [constants.ZSTD_c_strategy]: constants.ZSTD_btultra2,
    },
  });
  if (zstd.length < sizeThreshold) {
    yield { format: 'zstd', content: zstd };
  }

  const gzip = gzipSync(content, {
    level: constants.Z_BEST_COMPRESSION,
  });
  if (gzip.length < sizeThreshold) {
    yield { format: 'gzip', content: gzip };
  }
}
