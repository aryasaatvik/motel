---
packages:
  "@aryasaatvik/motel": patch
---

## Honor explicit services and normalize severity queries

The TUI now honors an explicitly configured service before restoring its remembered
selection. Log searches match severity names regardless of ASCII casing, and severity
statistics and facets group those variants consistently while preserving stored log text.
A matching index keeps case-insensitive severity searches efficient.
