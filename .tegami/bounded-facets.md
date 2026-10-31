---
packages:
  "@aryasaatvik/motel": patch
---

### Keep facet queries inside the query deadline on large stores

The log service facet now counts through an index instead of reading every log in the lookback window. The attribute-key picker ranks keys over the newest 500 traces in the window instead of every trace. On a 4 GB store these took 5 s and 10–43 s; they now take tens of milliseconds and no longer hold up searches queued behind them.
