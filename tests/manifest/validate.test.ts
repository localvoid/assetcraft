import { describe, expect, test } from 'bun:test';

import type { Manifest, ManifestEntry } from '../../src/manifest.js';
import { MANIFEST_VERSION } from '../../src/manifest.js';
import {
  assertManifest,
  assertManifestEntry,
  assertManifestReferences,
  isManifestEntryType,
  parseManifest,
  validateManifest,
  validateManifestEntries,
  validateManifestEntry,
  validateManifestReferences,
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

  test('rejects bad compressible', () => {
    for (const compressible of ['yes', 1, 0]) {
      expect(validateManifestEntry(validEntry({ compressible }))).toContain(
        'compressible must be a boolean',
      );
    }
    expect(validateManifestEntry(validEntry({ compressible: true }))).toEqual([]);
    expect(validateManifestEntry(validEntry({ compressible: false }))).toEqual([]);
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
          preload: [{ url: '/assets/hero.png', as: 'image' }],
          module: 'esm',
          entry: true,
          deps: ['/assets/dep.js'],
          width: 100,
          height: 50,
        }),
      ),
    ).toEqual([]);
  });

  test('accepts an optional debug symbols reference', () => {
    expect(validateManifestEntry(validEntry({ symbols: '/assets/app.js.map' }))).toEqual([]);
    expect(validateManifestEntry(validEntry({ symbols: 42 }))).toContain(
      'symbols must be a string',
    );
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

  test('rejects bad preload', () => {
    expect(validateManifestEntry(validEntry({ preload: true }))).toContain(
      'preload must be an array',
    );
    expect(validateManifestEntry(validEntry({ preload: [42] }))).toContain(
      'preload[0] must be an object',
    );
    expect(validateManifestEntry(validEntry({ preload: [{ url: '' }] }))).toContain(
      'preload[0].url must be a non-empty string',
    );
    expect(validateManifestEntry(validEntry({ preload: [{ url: '/a.png', as: '' }] }))).toContain(
      'preload[0].as must be a non-empty string',
    );
    expect(
      validateManifestEntry(validEntry({ preload: [{ url: '/a.png', crossorigin: 'always' }] })),
    ).toContain('preload[0].crossorigin must be "anonymous" or "use-credentials"');
    expect(
      validateManifestEntry(validEntry({ preload: [{ url: '/a.png', fetchPriority: 'urgent' }] })),
    ).toContain('preload[0].fetchPriority must be "high", "low", or "auto"');
    expect(
      validateManifestEntry(validEntry({ preload: [{ url: '/a.png', media: '' }] })),
    ).toContain('preload[0].media must be a non-empty string');
    expect(
      validateManifestEntry(
        validEntry({
          preload: [
            {
              url: '/fonts/body.woff2',
              as: 'font',
              crossorigin: 'anonymous',
              fetchPriority: 'high',
              media: 'screen',
            },
          ],
        }),
      ),
    ).toEqual([]);
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

describe('validateManifestEntries', () => {
  test('accepts an empty array and arrays of valid entries', () => {
    expect(validateManifestEntries([])).toEqual([]);
    expect(validateManifestEntries([validEntry(), validEntry({ path: 'b.js' })])).toEqual([]);
  });

  test('rejects non-arrays', () => {
    expect(validateManifestEntries({})).toEqual(['entries must be an array']);
    expect(validateManifestEntries('[]')).toEqual(['entries must be an array']);
  });

  test('prefixes problems with entry index', () => {
    const errors = validateManifestEntries([validEntry(), validEntry({ path: '' })]);
    expect(errors).toHaveLength(1);
    expect(errors.join('\n')).toContain('[1]');
    expect(errors.join('\n')).toContain('path must be a non-empty string');
  });
});

describe('validateManifestReferences', () => {
  function refEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'js',
      mime: 'application/javascript',
      url: '/assets/app.js',
      path: 'assets/app.js',
      sha256: 'abcDEF123-_',
      size: 128,
      ...overrides,
    };
  }

  function manifestOf(...entries: Record<string, unknown>[]): Manifest {
    return {
      version: MANIFEST_VERSION,
      entries: entries as unknown as ManifestEntry[],
    };
  }

  function linkedSet(): Manifest {
    return manifestOf(
      refEntry({
        symbols: 'assets/app.js.map',
        deps: ['/assets/dep.js'],
        preload: [{ url: '/assets/dep.js' }],
      }),
      refEntry({ url: '/assets/dep.js', path: 'assets/dep.js' }),
      {
        type: 'sourcemap',
        mime: 'application/json',
        url: '/assets/app.js.map',
        path: 'assets/app.js.map',
        sha256: 'mapDEF123-_',
        size: 64,
        source: 'assets/app.js',
      },
      {
        type: 'video',
        mime: 'video/mp4',
        url: '/assets/clip.mp4',
        path: 'assets/clip.mp4',
        sha256: 'vidDEF123-_',
        size: 1024,
        poster: '/assets/poster.jpg',
      },
      {
        type: 'image',
        mime: 'image/jpeg',
        url: '/assets/poster.jpg',
        path: 'assets/poster.jpg',
        sha256: 'imgDEF123-_',
        size: 512,
      },
      {
        type: 'image',
        mime: 'image/jpeg',
        url: '/assets/photo.jpg',
        path: 'assets/photo.jpg',
        sha256: 'phoDEF123-_',
        size: 256,
        srcset: [{ url: '/assets/photo-2x.jpg', density: 2 }],
      },
      {
        type: 'image',
        mime: 'image/jpeg',
        url: '/assets/photo-2x.jpg',
        path: 'assets/photo-2x.jpg',
        sha256: 'ph2DEF123-_',
        size: 512,
      },
    );
  }

  test('accepts empty and reference-free manifests', () => {
    expect(validateManifestReferences([])).toEqual([]);
    expect(validateManifestReferences(manifestOf(refEntry()))).toEqual([]);
  });

  test('accepts a fully linked manifest set', () => {
    expect(validateManifestReferences(linkedSet())).toEqual([]);
  });

  test('reports dangling pipeline references', () => {
    expect(
      validateManifestReferences(manifestOf(refEntry({ symbols: 'assets/missing.js.map' }))),
    ).toEqual(["[0] symbols 'assets/missing.js.map' matches no manifest entry path"]);
    expect(
      validateManifestReferences(
        manifestOf({
          type: 'sourcemap',
          mime: 'application/json',
          url: '/assets/app.js.map',
          path: 'assets/app.js.map',
          sha256: 'mapDEF123-_',
          size: 64,
          source: 'assets/missing.js',
        }),
      ),
    ).toEqual(["[0] source 'assets/missing.js' matches no manifest entry path"]);
  });

  test('requires symbols to point at a sourcemap entry', () => {
    expect(
      validateManifestReferences(manifestOf(refEntry({ symbols: 'assets/app.js' }))),
    ).toEqual(["[0] symbols 'assets/app.js' must reference a 'sourcemap' entry (found 'js')"]);
  });

  test('reports dangling serving references', () => {
    expect(
      validateManifestReferences(
        manifestOf(
          refEntry({
            deps: ['/assets/missing.js'],
            preload: [{ url: '/assets/other.js' }],
            poster: '/missing.jpg',
            srcset: [{ url: '/missing-2x.jpg' }],
          }),
        ),
      ),
    ).toEqual([
      "[0] deps[0] '/assets/missing.js' matches no manifest entry url",
      "[0] preload[0].url '/assets/other.js' matches no manifest entry url",
      "[0] poster '/missing.jpg' matches no manifest entry url",
      "[0] srcset[0].url '/missing-2x.jpg' matches no manifest entry url",
    ]);
  });

  test('skips absolute serving references unless checkExternalUrls is set', () => {
    const manifest = manifestOf(
      refEntry({
        preload: [
          { url: 'https://cdn.example/font.woff2' },
          { url: '//cdn.example/other.woff2' },
        ],
      }),
    );
    expect(validateManifestReferences(manifest)).toEqual([]);
    expect(validateManifestReferences(manifest, { checkExternalUrls: true })).toEqual([
      "[0] preload[0].url 'https://cdn.example/font.woff2' matches no manifest entry url",
      "[0] preload[1].url '//cdn.example/other.woff2' matches no manifest entry url",
    ]);
  });

  test('honors the ignore list', () => {
    const manifest = manifestOf(refEntry({ preload: [{ url: '/api/config', as: 'fetch' }] }));
    expect(validateManifestReferences(manifest)).toEqual([
      "[0] preload[0].url '/api/config' matches no manifest entry url",
    ]);
    expect(validateManifestReferences(manifest, { ignore: ['/api/config'] })).toEqual([]);
  });

  test('resolves references across manifests with per-manifest indexes', () => {
    const vendor = manifestOf(refEntry({ url: '/vendor/lib.js', path: 'vendor/lib.js' }));
    expect(
      validateManifestReferences([manifestOf(refEntry({ deps: ['/vendor/lib.js'] })), vendor]),
    ).toEqual([]);
    expect(
      validateManifestReferences([manifestOf(refEntry({ deps: ['/vendor/missing.js'] })), vendor]),
    ).toEqual(["[0][0] deps[0] '/vendor/missing.js' matches no manifest entry url"]);
  });

  test('matches object-form urls by origin and path', () => {
    const manifest = manifestOf(
      refEntry({ preload: [{ url: 'https://cdn.example/assets/a.js' }] }),
      {
        ...refEntry(),
        url: { origin: 'https://cdn.example', path: '/assets/a.js' },
        path: 'assets/a.js',
      },
    );
    expect(validateManifestReferences(manifest)).toEqual([]);
  });

  test('ignores non-string and non-object values', () => {
    expect(
      validateManifestReferences(
        manifestOf(refEntry({ symbols: 42, deps: 'x', poster: null, preload: [42], srcset: 'x' })),
      ),
    ).toEqual([]);
    expect(
      validateManifestReferences({
        version: MANIFEST_VERSION,
        entries: [null, 42],
      } as unknown as Manifest),
    ).toEqual([]);
  });

  test('assertManifestReferences throws listing all problems', () => {
    expect(() => assertManifestReferences(linkedSet())).not.toThrow();
    let error: unknown;
    try {
      assertManifestReferences(manifestOf(refEntry({ symbols: 'assets/missing.js.map' })));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toContain('Invalid manifest references: ');
    expect((error as Error).message).toContain(
      "[0] symbols 'assets/missing.js.map' matches no manifest entry path",
    );
  });
});

describe('validateManifest', () => {
  function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { version: MANIFEST_VERSION, entries: [validEntry()], ...overrides };
  }

  test('accepts a valid manifest', () => {
    expect(validateManifest(manifest())).toEqual([]);
  });

  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 42, 'manifest', []]) {
      expect(validateManifest(bad)).toEqual([
        'manifest must be an object with version and entries',
      ]);
    }
  });

  test('rejects missing or unsupported versions', () => {
    for (const version of [undefined, 0, 2, '1', null]) {
      expect(validateManifest(manifest({ version }))).toContain(
        `version must be ${MANIFEST_VERSION}`,
      );
    }
  });

  test('rejects non-array entries', () => {
    expect(validateManifest(manifest({ entries: {} }))).toContain('entries must be an array');
  });

  test('prefixes entry problems with entries[i]', () => {
    const errors = validateManifest(manifest({ entries: [validEntry({ path: '' })] }));
    expect(errors).toEqual(['entries[0] path must be a non-empty string']);
  });

  test('collects manifest and entry problems together', () => {
    const errors = validateManifest({ version: 2, entries: [validEntry({ path: '' })] });
    expect(errors).toEqual([
      `version must be ${MANIFEST_VERSION}`,
      'entries[0] path must be a non-empty string',
    ]);
  });
});

describe('assertManifest', () => {
  test('passes for valid manifests', () => {
    expect(() =>
      assertManifest({ version: MANIFEST_VERSION, entries: [validEntry()] }),
    ).not.toThrow();
  });

  test('throws listing all problems', () => {
    let error: unknown;
    try {
      assertManifest({ version: 2, entries: 'nope' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toContain('Invalid manifest: ');
    expect((error as Error).message).toContain(`version must be ${MANIFEST_VERSION}`);
    expect((error as Error).message).toContain('entries must be an array');
  });
});

describe('parseManifest', () => {
  test('parses a valid JSON manifest', () => {
    const entry = validEntry();
    const manifest = parseManifest(
      JSON.stringify({ version: MANIFEST_VERSION, entries: [entry] }),
    );
    expect(manifest as unknown).toEqual({ version: MANIFEST_VERSION, entries: [entry] });
  });

  test('throws on invalid JSON', () => {
    expect(() => parseManifest('{nope')).toThrow('Invalid manifest JSON: ');
  });

  test('throws on non-manifest payloads', () => {
    expect(() => parseManifest('{}')).toThrow('Invalid manifest: ');
    expect(() => parseManifest('[]')).toThrow('manifest must be an object');
  });

  test('throws on invalid entries with index', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ version: MANIFEST_VERSION, entries: [validEntry({ path: '' })] }),
      ),
    ).toThrow('entries[0]');
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
