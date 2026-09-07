---
packages:
  "@aryasaatvik/motel": patch
---

## Bound query backlog and cancel obsolete work

Read-only queries now have bounded FIFO admission and deadlines, with explicit HTTP 503/504
errors. Expired executing queries release their SQLite reader before subsequent work runs;
ingestion keeps its own worker. The TUI coalesces refreshes and bounds facet prefetch, and
span searches load only the ancestors of returned spans instead of whole traces.
