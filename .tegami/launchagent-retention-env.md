---
packages:
  "@aryasaatvik/motel": patch
---

### Keep retention settings in the LaunchAgent

`motel service install` now writes retention settings such as `MOTEL_OTEL_MAX_DB_SIZE_MB` and `MOTEL_OTEL_RETENTION_HOURS` from the install environment into the LaunchAgent, and keeps installed values when replacing the service. `motel service status` reports a requested retention value that differs from the installed one.
