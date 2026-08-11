---
packages:
  "@aryasaatvik/motel": patch
---

## Stabilize managed telemetry ingestion

Managed Motel services now wait until trace and log ingestion are ready before reporting startup
success. Aborted requests no longer replace shared telemetry workers, and SQLite initialization
waits for writer locks instead of continuing with an unusable store.
