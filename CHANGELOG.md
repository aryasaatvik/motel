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
