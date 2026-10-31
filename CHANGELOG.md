## @aryasaatvik/motel@0.5.7

### Keep facet queries inside the query deadline on large stores

The log service facet now counts through an index instead of reading every log in the lookback window. The attribute-key picker ranks keys over the newest 500 traces in the window instead of every trace. On a 4 GB store these took 5 s and 10–43 s; they now take tens of milliseconds and no longer hold up searches queued behind them.

### Keep the query process warm when a client gives up

A client that disconnects or times out no longer kills Motel's readonly query process. The query finishes within its deadline, and the next request reuses the warm process. Before, a client with a short timeout could start a cascade in which every following search paid a cold restart and timed out in turn. Only a query that overruns `MOTEL_OTEL_QUERY_DEADLINE_MS` still restarts the process.

## @aryasaatvik/motel@0.5.6

### Keep service discovery fast on large stores

Listing services now reads one index entry per service instead of every span and log in the lookback window. On multi-GB stores, `/api/services` and the TUI's auto-refresh no longer exceed the query deadline or hold up trace, log, and span searches queued behind them.

## @aryasaatvik/motel@0.5.5

### Evict the oldest telemetry first when the database is over its size cap

When the database exceeds `MOTEL_OTEL_MAX_DB_SIZE_MB`, Motel now removes traces and logs in age order. Before, every log became eligible at once, so fresh logs disappeared within milliseconds while older spans kept the database full.

## @aryasaatvik/motel@0.5.4

### Keep retention settings in the LaunchAgent

`motel service install` now writes retention settings such as `MOTEL_OTEL_MAX_DB_SIZE_MB` and `MOTEL_OTEL_RETENTION_HOURS` from the install environment into the LaunchAgent, and keeps installed values when replacing the service. `motel service status` reports a requested retention value that differs from the installed one.

## @aryasaatvik/motel@0.5.3

### Require Bun 1.4.4

Require Bun 1.4.4 or newer to run Motel, and select Bun 1.4.4 for repository and release tooling.

## @aryasaatvik/motel@0.5.2

### Keep trace ingestion fast as history grows

Use indexed row mappings to replace span operation search entries without scanning retained history. Existing databases repair their mappings before enabling this path, and failed search-index updates roll back atomically.

## @aryasaatvik/motel@0.5.1

### Use stable Effect v4

Upgrade the daemon, CLI, telemetry ingestion, and browser UI to stable Effect 4.0.0 and its matching integrations.

## @aryasaatvik/motel@0.5.0

### Run on Effect 4.0.0-rc.117

Motel now depends on Effect 4.0.0-rc.117. Hosts that override `effect` to rc.113 or later
crashed at startup with `Argument.string is not a function`, because Effect renamed its CLI
constructors. MCP server logs now go to stderr, keeping stdout for the protocol.

## @aryasaatvik/motel@0.4.0

### Inspect ingestion readiness without waiting for SQLite

`GET /api/readiness` and `motel status` expose cached writer startup, backlog, commit progress,
and maintenance timing. Busy ingestion no longer needs another queued write to explain its
state. OTLP responses still acknowledge only committed records.

Concurrent cold starts now publish their shared startup lock atomically. Ensure operations
preserve an existing live daemon when ingestion is slow or unavailable, and report operator
diagnostics instead of restarting another worktree's writer.

### Bound query backlog and cancel obsolete work

Read-only queries now have bounded FIFO admission and deadlines, with explicit HTTP 503/504
errors. Expired executing queries release their SQLite reader before subsequent work runs;
ingestion keeps its own worker. The TUI coalesces refreshes and bounds facet prefetch, and
span searches load only the ancestors of returned spans instead of whole traces.

### Keep ingestion progressing during retention

Routine checkpoints no longer wait for long-running readers, and readiness reports incomplete
checkpoint progress. Retention hides completed traces atomically and removes their rows in
bounded, recoverable batches. Active traces remain protected. FTS merging now runs correctly,
and indexed deletion plus bounded legacy repair avoids repeated orphan-table scans.

## @aryasaatvik/motel@0.3.5

### Honor explicit services and normalize severity queries

The TUI now honors an explicitly configured service before restoring its remembered
selection. Log searches match severity names regardless of ASCII casing, and severity
statistics and facets group those variants consistently while preserving stored log text.
A matching index keeps case-insensitive severity searches efficient.

## @aryasaatvik/motel@0.3.4

### Run Motel on Effect 4 RC 112

Motel now ships on Effect `4.0.0-rc.112`. The release workflow also publishes
through npm trusted publishing from GitHub Actions without an `NPM_TOKEN`.

## @aryasaatvik/motel@0.3.3

### Run Motel on Effect 4 RC

Motel now ships on Effect `4.0.0-rc.110` instead of the beta line. The MCP
server advertises the published protocol revisions, and `motel service install`
still treats `--replace` as optional.

## @aryasaatvik/motel@0.3.2

### Stabilize managed telemetry ingestion

Managed Motel services now wait until trace and log ingestion are ready before reporting startup
success. Aborted requests no longer replace shared telemetry workers, and SQLite initialization
waits for writer locks instead of continuing with an unusable store.

## @aryasaatvik/motel@0.3.1

### Stop detached daemons during LaunchAgent transitions

Make `motel stop` terminate a verified detached daemon when the per-user LaunchAgent definition
exists but is not currently loaded.

## @aryasaatvik/motel@0.3.0

### Establish maintained fork ownership

Publish Motel under `@aryasaatvik/motel` from the maintained fork while preserving the `motel`
and `motel-mcp` executable names.

### Adopt an Effect-native CLI

Replace the manual argument router with Effect's CLI primitives, provide generated command help and
validation, and report the installed package version through `motel --version`.

### Manage the machine-global service

Add native LaunchAgent install, uninstall, and status commands while preserving Motel's foreground
`server` mode and managed-daemon identity.

### Upgrade Effect

Upgrade Motel to the applicable Effect v4 beta used by the new CLI and runtime integration.
