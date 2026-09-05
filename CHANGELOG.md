# Changelog

## 0.2.0 — 2026-09-05

- Support OpenClaw 2026.9.1 through the September release series. This release
  requires OpenClaw >=2026.9.1 and <2026.10.0.
- Replace removed SDK imports with the public channel, outbound, and infrastructure
  interfaces; derive state and secret types from the supported public contracts.
- Adapt text delivery to both outbound interfaces and remove retired channel
  metadata and mention fields.
- Preserve attachment handling, reply threads, reactions, typing, and durable
  history cursors. Validate attachment delivery using September's typed media
  context in the real OpenClaw dispatcher.
- Include compiled runtime files in the GitHub release archive.
