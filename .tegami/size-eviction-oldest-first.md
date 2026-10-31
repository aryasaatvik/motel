---
packages:
  "@aryasaatvik/motel": patch
---

### Evict the oldest telemetry first when the database is over its size cap

When the database exceeds `MOTEL_OTEL_MAX_DB_SIZE_MB`, Motel now removes traces and logs in age order. Before, every log became eligible at once, so fresh logs disappeared within milliseconds while older spans kept the database full.
