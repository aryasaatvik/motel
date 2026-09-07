# motel

A local OpenTelemetry ingest + TUI viewer for development, backed by
SQLite. Point your app's OTLP/HTTP exporters at the local motel server
and debug with real runtime evidence — from a terminal, the built-in web
UI, or directly from an AI coding agent.

## For agents: install the motel-debug skill

`motel` ships a companion skill that teaches Claude Code, OpenCode,
Cursor, Codex, and 40+ other agents how to debug with runtime evidence
by querying motel's local OTLP store. Install it once and any future
agent session in the project will know how to use it.

```bash
# Project-local (adds to .claude/skills, .agents/skills, etc.)
npx skills add aryasaatvik/motel --skill motel-debug

# Or globally, for every project
npx skills add aryasaatvik/motel --skill motel-debug -g
```

See the full skill at [`skills/motel-debug/SKILL.md`](skills/motel-debug/SKILL.md).

## For humans: install and run the TUI

motel is distributed on npm as `@aryasaatvik/motel`. The binary is a Bun
script, so Bun must be on your `PATH` at runtime:

```bash
# one-off (no install)
bunx @aryasaatvik/motel

# or install globally
bun add -g @aryasaatvik/motel
motel

# npm also works (Bun still required to run it)
npm install -g @aryasaatvik/motel
```

Don't have Bun?

```bash
curl -fsSL https://bun.sh/install | bash
```

`motel` starts the local OTLP ingest server on
`http://127.0.0.1:27686` and launches the TUI. Press `?` once inside for
the keyboard cheat sheet, or `c` to copy paste-ready setup instructions
for any Effect/OTEL app you want to trace.

Requirements: [Bun](https://bun.sh/) v1.1 or newer.

### macOS service from the maintained checkout

The per-user LaunchAgent intentionally runs
`~/.bun/bin/bun ~/.bun/bin/motel server`. For a maintained-checkout
installation, prepare and link the merged `dev` checkout before installing
the service:

```bash
bun install --frozen-lockfile
bun run web:build
bun link
motel service install
```

This service path does not discover npm-global or arbitrary `PATH`
executables. `motel service install` verifies both stable Bun bin paths before
writing or loading the LaunchAgent. Re-running it leaves an equivalent loaded
service unchanged and loads an equivalent definition that is currently
unloaded.

## How your app connects

Once motel is running, point your app's OTLP/HTTP exporters at these
local endpoints:

```
http://127.0.0.1:27686/v1/traces
http://127.0.0.1:27686/v1/logs
```

Motel keeps everything in a machine-global local SQLite database at
`${XDG_STATE_HOME:-~/.local/state}/motel/telemetry.sqlite`. One managed
daemon is shared across local projects. No Docker, no cloud account.

The store retains seven days of telemetry by default and targets a 1 GB
active-data ceiling using bounded background batches. Recent data is preserved while
the oldest completed traces and logs are removed first. Configure the policy
with `MOTEL_OTEL_RETENTION_HOURS`, `MOTEL_OTEL_MAX_DB_SIZE_MB`,
`MOTEL_OTEL_RETENTION_TRACE_BATCH`, `MOTEL_OTEL_RETENTION_LOG_BATCH`, and
`MOTEL_OTEL_RETENTION_INTERVAL_SECONDS`. Existing databases created without
incremental auto-vacuum are never silently rewritten at startup; deleted pages
are reused, but shrinking such a historical file requires an explicit offline
SQLite `VACUUM` chosen by the user.

## How agents connect

Agents with the `motel-debug` skill installed will automatically use
motel's HTTP API. The full OpenAPI spec is at
`http://127.0.0.1:27686/openapi.json` — the key endpoints are:

```
GET /api/health                              liveness check
GET /api/services                            services reporting telemetry
GET /api/traces?service=<service>            recent traces for a service
GET /api/traces/<trace-id>                   full trace tree
GET /api/spans/<span-id>                     single span + logs
GET /api/logs?service=<service>              recent logs
GET /api/traces/search?...                   structured trace search
GET /api/logs/search?...                     structured log search
GET /api/ai/calls                            AI SDK call inspector
```

## TUI keys

- `?` — keyboard cheat sheet
- `j` / `k` or `↑` / `↓` — move selection
- `enter` / `esc` — drill in / back out (trace → waterfall → span detail)
- `[` / `]` — switch service
- `tab` — toggle service logs
- `/` — filter traces
- `s` — cycle sort (recent → slowest → errors)
- `t` — cycle theme
- `c` — copy paste-ready setup instructions for another app
- `o` — open selected trace in the browser
- `q` — quit

## Privacy note

motel is a local development tool, but your app can emit sensitive
telemetry. Correlated logs may include secrets, tokens, or PII if your
app logs them; AI call traces may include full prompt content and
response text. Treat the local SQLite store as sensitive development
data when pointing motel at real workloads.

### Ingestion readiness

`GET /api/health` reports process identity and liveness. `GET /api/readiness` reports cached
writer diagnostics without querying SQLite or joining the ingestion queue. It returns HTTP
200 for `ready`, and 503 for `starting`, `overloaded`, or `failed`. `motel status` includes this
snapshot when the daemon supports it; older servers remain compatible.

`overloaded` means an awaiting request is at least five seconds old or at least 64 requests
are outstanding. This is a pressure signal, not an instruction to restart a shared daemon.
Idle time does not imply failure. `failed` records worker exit/error and requires operator
inspection. Outstanding counts/bytes describe awaiting callers, not durable queued data;
client cancellation cannot undo a SQLite commit. Empty probes do not advance `lastCommitAt`.
Maintenance reports its latest operation, duration, and outcome without telemetry payloads.

Run `bun scripts/bench-shared-daemon.ts` for an isolated reduced-cap mixed workload, or add
`--1gib` for the representative capacity profile. Both create and remove their own database,
include a held reader, and report request latency percentiles, failures, and database/WAL size.
They never benchmark the shared machine-global database.

Concurrent starts publish a complete shared lock atomically. Ensure operations preserve a live
daemon when ingestion is slow; explicit operator recovery remains available through `motel restart`.
An unreadable lock or interrupted stale-lock recovery fails closed and reports its path for inspection.
When maintenance operations overlap, readiness shows the oldest active operation before a completed one.

Retention marks completed traces and expired logs before removing dependent rows. Public query
results hide the whole marked trace, including correlated logs, while bounded cleanup proceeds.
Markers persist across restarts. Arrivals for a marked trace are discarded as part of its eviction
and do not count as inserted records; once cleanup finishes, later exports may recreate that trace.
Active traces are not selected. SQLite tables are internal storage; direct SQL consumers should
use the `retained_spans`, `retained_logs`, and `retained_trace_summaries` views for this visibility rule.

`MOTEL_OTEL_RETENTION_ROW_BATCH` defaults to 1000 logical rows per cleanup batch, split across
traces and logs. It bounds row cardinality, not the size of one telemetry field. Cleanup yields
100 ms between batches while making progress, then returns to the configured idle interval.
Routine checkpoints use PASSIVE and report busy/frame counts in readiness; physical reclamation
is deferred for held readers. The configured database target and WAL size limit are not hard caps.
Existing orphan attributes/FTS entries are repaired with bounded keyset scans; normal ingests
maintain reverse FTS mappings for indexed cleanup.
