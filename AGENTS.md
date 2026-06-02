# assetcraft

TypeScript library for managing static web assets.

## Package Structure

```
src/
  manifest.ts   # Manifest types, constants, and `importManifests` helper
  manifest/
    build.ts    # ManifestBuilder
    history.ts  # AssetsHistory
  file.ts       # FileSystem utils
  compress.ts   # Compression utils
```

## Commands

- `bun run check` - Type-aware lint (oxlint + oxlint-tsgolint, typeCheck: true)
