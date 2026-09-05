import { describe, expect, test } from 'bun:test';

import {
  assertManifestEntry,
  isManifestEntryType,
  parseManifest,
  validateManifest,
  validateManifestEntry,
} from '../../src/manifest/validate.js';

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'js',
    mime: 'application/javascript',
    url: '/assets/app.js',
    path: 'app.js',
    sha256: 'abcDEF123-_',
    size: 128,
    ...overrides,
  };
}

describe('validateManifestEntry', () => {
  test('accepts a minimal valid entry', () => {
    expect(validateManifestEntry(validEntry())).toEqual([]);
  });

  test('accepts all entry types and optional fields', () => {
    for (const type of [
      'js',
      'wasm',
      'html',
      'css',
      'font',
      'image',
      'svg',
      'audio',
      'video',
      'text',
      'binary',
      'sourcemap',
      'compression-dictionary',
    ]) {
      const extra =
        type === 'compression-dictionary' ? { match: '*.js', matchDest: '/dict.br' } : {};
      expect(validateManifestEntry(validEntry({ type, ...extra }))).toEqual([]);
    }
    expect(
      validateManifestEntry(
        validEntry({
          name: ['a', 'b'],
          tags: ['t'],
          headers: { 'cache-control': 'max-age=1' },
          url: { origin: 'https://cdn.example', path: '/a.js' },
        }),
      ),
    ).toEqual([]);
  });

  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 42, 'entry']) {
      expect(validateManifestEntry(bad)).toContain('entry must be an object');
    }
  });

  test('rejects unknown or missing type', () => {
    expect(validateManifestEntry(validEntry({ type: 'exe' }))[0]).toContain('type must be one of');
    expect(validateManifestEntry(validEntry({ type: 'misc' }))[0]).toContain('type must be one of');
    expect(validateManifestEntry(validEntry({ type: undefined }))[0]).toContain(
      'type must be one of',
    );
  });

  test('rejects bad mime', () => {
    expect(validateManifestEntry(validEntry({ mime: '' }))).toContain(
      'mime must be a non-empty string',
    );
    expect(validateManifestEntry(validEntry({ mime: 42 }))).toContain(
      'mime must be a non-empty string',
    );
  });

  test('rejects bad immutable', () => {
    for (const immutable of ['yes', 1, 0]) {
      expect(validateManifestEntry(validEntry({ immutable }))).toContain(
        'immutable must be a boolean',
      );
    }
  });

  test('rejects bad url', () => {
    expect(validateManifestEntry(validEntry({ url: '' }))).toContain(
      'url must be a non-empty string',
    );
    expect(validateManifestEntry(validEntry({ url: 42 }))).toContain(
      'url must be a string or { origin, path }',
    );
    expect(validateManifestEntry(validEntry({ url: { origin: 'https://x' } }))).toContain(
      'url object must have string origin and path',
    );
    expect(validateManifestEntry(validEntry({ url: null }))).toContain(
      'url must be a string or { origin, path }',
    );
  });

  test('rejects bad path', () => {
    expect(validateManifestEntry(validEntry({ path: '' }))).toContain(
      'path must be a non-empty string',
    );
    expect(validateManifestEntry(validEntry({ path: undefined }))).toContain(
      'path must be a non-empty string',
    );
  });

  test('rejects bad sha256', () => {
    for (const sha256 of ['', 'abc+def', 'abc/def', 'abc==', 42]) {
      expect(validateManifestEntry(validEntry({ sha256 }))).toContain(
        'sha256 must be a base64url-encoded string',
      );
    }
  });

  test('rejects bad size', () => {
    for (const size of [-1, 1.5, '128', Number.NaN, undefined]) {
      expect(validateManifestEntry(validEntry({ size }))).toContain(
        'size must be a non-negative integer',
      );
    }
  });

  test('accepts serving metadata and media hints', () => {
    expect(
      validateManifestEntry(
        validEntry({
          integrity: 'sha384-abcDEF123+/==',
          compressed: { br: { path: 'app.js.br', size: 40, sha256: 'abcDEF123-_' } },
          crossorigin: 'anonymous',
          fetchPriority: 'high',
          preload: true,
          module: 'esm',
          entry: true,
          deps: ['/assets/dep.js'],
          width: 100,
          height: 50,
        }),
      ),
    ).toEqual([]);
  });

  test('rejects bad serving metadata', () => {
    expect(validateManifestEntry(validEntry({ integrity: 'md5-abc' }))).toContain(
      'integrity must be an SRI string (e.g. "sha384-…")',
    );
    expect(
      validateManifestEntry(validEntry({ compressed: { br: { path: '', size: -1 } } })),
    ).toEqual([
      'compressed.br.path must be a non-empty string',
      'compressed.br.size must be a non-negative integer',
    ]);
    expect(validateManifestEntry(validEntry({ compressed: { deflate: {} } }))).toContain(
      "compressed has unknown format 'deflate'",
    );
    expect(validateManifestEntry(validEntry({ crossorigin: 'always' }))).toContain(
      'crossorigin must be "anonymous" or "use-credentials"',
    );
    expect(validateManifestEntry(validEntry({ width: -1 }))).toContain(
      'width must be a non-negative integer',
    );
    expect(validateManifestEntry(validEntry({ duration: -0.5 }))).toContain(
      'duration must be a non-negative number',
    );
    expect(validateManifestEntry(validEntry({ module: 'cjs' }))).toContain(
      'module must be "esm" or "script"',
    );
  });

  test('rejects bad name', () => {
    for (const name of ['', [], [42], ['ok', ''], 42]) {
      expect(validateManifestEntry(validEntry({ name }))).toContain(
        'name must be a non-empty string or an array of non-empty strings',
      );
    }
  });

  test('rejects bad tags', () => {
    expect(validateManifestEntry(validEntry({ tags: 'x' }))).toContain(
      'tags must be an array of strings',
    );
    expect(validateManifestEntry(validEntry({ tags: ['ok', 42] }))).toContain(
      'tags must be an array of strings',
    );
  });

  test('rejects bad headers', () => {
    for (const headers of ['x', [], { a: 42 }, null]) {
      expect(validateManifestEntry(validEntry({ headers }))).toContain(
        'headers must be a record of string to string',
      );
    }
  });

  test('requires match for compression-dictionary entries', () => {
    expect(validateManifestEntry(validEntry({ type: 'compression-dictionary' }))).toContain(
      'match must be a non-empty string for compression-dictionary entries',
    );
    expect(
      validateManifestEntry(validEntry({ type: 'compression-dictionary', match: '' })),
    ).toContain('match must be a non-empty string for compression-dictionary entries');
    expect(
      validateManifestEntry(
        validEntry({ type: 'compression-dictionary', match: '*.js', matchDest: 42 }),
      ),
    ).toContain('matchDest must be a string for compression-dictionary entries');
  });

  test('collects multiple problems at once', () => {
    const errors = validateManifestEntry(validEntry({ mime: '', path: '' }));
    expect(errors).toHaveLength(2);
  });
});

describe('assertManifestEntry', () => {
  test('passes for valid entries', () => {
    expect(() => assertManifestEntry(validEntry())).not.toThrow();
  });

  test('throws listing all problems', () => {
    let error: unknown;
    try {
      assertManifestEntry(validEntry({ mime: '', path: '' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toContain('Invalid manifest entry: ');
    expect((error as Error).message).toContain('mime must be a non-empty string');
    expect((error as Error).message).toContain('path must be a non-empty string');
  });
});

describe('validateManifest', () => {
  test('accepts an empty array and arrays of valid entries', () => {
    expect(validateManifest([])).toEqual([]);
    expect(validateManifest([validEntry(), validEntry({ path: 'b.js' })])).toEqual([]);
  });

  test('rejects non-arrays', () => {
    expect(validateManifest({})).toEqual(['manifest must be an array']);
    expect(validateManifest('[]')).toEqual(['manifest must be an array']);
  });

  test('prefixes problems with entry index', () => {
    const errors = validateManifest([validEntry(), validEntry({ path: '' })]);
    expect(errors).toHaveLength(1);
    expect(errors.join('\n')).toContain('[1]');
    expect(errors.join('\n')).toContain('path must be a non-empty string');
  });
});

describe('parseManifest', () => {
  test('parses a valid JSON manifest', () => {
    const entry = validEntry();
    const manifest = parseManifest(JSON.stringify([entry]));
    expect(manifest as unknown).toEqual([entry]);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseManifest('{nope')).toThrow('Invalid manifest JSON: ');
  });

  test('throws on non-array payload', () => {
    expect(() => parseManifest('{}')).toThrow('Invalid manifest: manifest must be an array');
  });

  test('throws on invalid entries with index', () => {
    expect(() => parseManifest(JSON.stringify([validEntry({ path: '' })]))).toThrow('[0]');
  });
});

describe('isManifestEntryType', () => {
  test('accepts known types', () => {
    for (const type of [
      'js',
      'wasm',
      'html',
      'css',
      'font',
      'image',
      'svg',
      'audio',
      'video',
      'text',
      'binary',
      'sourcemap',
      'compression-dictionary',
    ]) {
      expect(isManifestEntryType(type)).toBe(true);
    }
  });

  test('rejects unknown or non-string types', () => {
    for (const type of ['exe', '', undefined, null, 42]) {
      expect(isManifestEntryType(type)).toBe(false);
    }
  });
});
