---
packages:
  "@aryasaatvik/motel": patch
---

## Stop detached daemons during LaunchAgent transitions

Make `motel stop` terminate a verified detached daemon when the per-user LaunchAgent definition
exists but is not currently loaded.
