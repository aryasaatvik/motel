---
packages:
  "@aryasaatvik/motel": patch
---

### Keep the query process warm when a client gives up

A client that disconnects or times out no longer kills Motel's readonly query process. The query finishes within its deadline, and the next request reuses the warm process. Before, a client with a short timeout could start a cascade in which every following search paid a cold restart and timed out in turn. Only a query that overruns `MOTEL_OTEL_QUERY_DEADLINE_MS` still restarts the process.
