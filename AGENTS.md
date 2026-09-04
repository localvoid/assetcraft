# assetcraft

TypeScript library for managing static web assets.

## File Structure

```
README.md
src/
  manifest.ts   # Manifest types, constants, and `importManifests` helper
  manifest/
    build.ts    # ManifestBuilder
    diff.ts     # diffManifests, isEqualManifestEntry
    prune.ts    # pruneDir, collectManifestPaths
    validate.ts # validate/parse manifest entries
  file.ts       # FileSystem utils
  history.ts    # AssetsHistory
  compress.ts   # Compression utils
  http.ts       # Cache-Control / response header helpers
```

## Commands

- `bun run check` - Type-aware lint (oxlint + oxlint-tsgolint, typeCheck: true)
