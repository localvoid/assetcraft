# assetcraft

TypeScript library for managing static web assets.

## File Structure

```
README.md
src/
  manifest.ts   # Manifest types, constants, and `importManifests` helper
  manifest/
    build.ts    # ManifestBuilder
  file.ts       # FileSystem utils
  history.ts    # AssetsHistory
  compress.ts   # Compression utils
```

## Commands

- `bun run check` - Type-aware lint (oxlint + oxlint-tsgolint, typeCheck: true)
