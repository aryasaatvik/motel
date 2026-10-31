---
packages:
  "@aryasaatvik/motel": patch
---

### Keep service discovery fast on large stores

Listing services now reads one index entry per service instead of every span and log in the lookback window. On multi-GB stores, `/api/services` and the TUI's auto-refresh no longer exceed the query deadline or hold up trace, log, and span searches queued behind them.
