---
packages:
  "@aryasaatvik/motel": minor
---

## Inspect ingestion readiness without waiting for SQLite

`GET /api/readiness` and `motel status` expose cached writer startup, backlog, commit progress,
and maintenance timing. Busy ingestion no longer needs another queued write to explain its
state. OTLP responses still acknowledge only committed records.

Concurrent cold starts now publish their shared startup lock atomically. Ensure operations
preserve an existing live daemon when ingestion is slow or unavailable, and report operator
diagnostics instead of restarting another worktree's writer.
