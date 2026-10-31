---
packages:
  "@aryasaatvik/motel": patch
---

### Index AI spans for AI-call queries

AI-call search and stats now seek a partial index over `ai.*` spans instead of reading every span in the lookback window. On a 4 GB store with no AI traffic, `/api/ai/calls` took 6 s and could hold up searches queued behind it. The first start on this version builds the index once, which briefly holds the write lock while it reads span operation names.
