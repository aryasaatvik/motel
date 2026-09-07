---
packages:
  "@aryasaatvik/motel": patch
---

## Keep ingestion progressing during retention

Routine checkpoints no longer wait for long-running readers, and readiness reports incomplete
checkpoint progress. Retention hides completed traces atomically and removes their rows in
bounded, recoverable batches. Active traces remain protected. FTS merging now runs correctly,
and indexed deletion plus bounded legacy repair avoids repeated orphan-table scans.
