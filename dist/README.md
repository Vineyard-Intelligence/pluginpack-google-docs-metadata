# dist/

`pack.mjs` is the published artifact: a single self-contained ES module (esbuild, minified, no
imports) that the Vineyard plugin worker fetches from this repo at the commit the registry pins and
runs in its sandbox. The catalog manifest `plugins/google-docs-metadata.manifest.json` points every
member at it (`platforms.web.entry: "dist/pack.mjs"`), and the bundle embeds its own copy of the
manifest — the registry check refuses a pin whose bundle and manifest disagree on version or
licence, so edit both together.

This repo carries no separate source tree or build script for the pack: `pack.mjs` is the
authoritative build and the copy of the code to edit.
