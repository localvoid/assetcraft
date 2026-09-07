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
  deploy.ts
  deploy/
    files.ts    # DeployFile, listDeployFiles, planDeploy
    history.ts  # DeployHistory, checkManifest, recordHistory
    state.ts    # DeployState (.deploy.json), checkDeploy
  file.ts       # FileSystem utils
  compress.ts   # Compression utils
  http.ts       # Cache-Control / response header helpers
```

## Commands

- `bun run check` - Type-aware lint (oxlint + oxlint-tsgolint, typeCheck: true)
