# dist/

`pack.mjs` is the published artifact: a single self-contained ES module (esbuild, minified, no
imports) that the Vineyard plugin worker fetches from this repo at the commit the registry pins and
runs in its sandbox. The catalog manifest `plugins/google-docs-metadata.manifest.json` points every
member at it (`platforms.web.entry: "dist/pack.mjs"`), and the bundle embeds its own copy of the
manifest — the registry check refuses a pin whose bundle and manifest disagree on version or
licence, so edit both together.

`pack.mjs` is built from `src/`, so change the source rather than this file:
`node build.mjs && git diff --exit-code dist/pack.mjs` checks the bundle against it.
