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
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
```

`motel` starts the local OTLP ingest server on
`http://127.0.0.1:27686` and launches the TUI. Press `?` once inside for
the keyboard cheat sheet, or `c` to copy paste-ready setup instructions
for any Effect/OTEL app you want to trace.

Requirements: [Bun](https://bun.sh/) matching `package.json` `engines.bun` (`>=1.4.4`).

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
`MOTEL_OTEL_RETENTION_TRACE_BATCH`, `MOTEL_OTEL_RETENTION_ROW_BATCH`,
`MOTEL_OTEL_RETENTION_LOG_BATCH`, and
`MOTEL_OTEL_RETENTION_INTERVAL_SECONDS`.
Existing databases created without
incremental auto-vacuum are never silently rewritten at startup; deleted pages
are reused, but shrinking such a historical file requires an explicit offline
SQLite `VACUUM` chosen by the user.

## Configuration

Processes that load `src/config.ts` resolve one base URL, in order:
`MOTEL_OTEL_BASE_URL`, `MOTEL_OTEL_QUERY_URL`, `MOTEL_OTEL_COLLECTOR_URL`,
then `http://127.0.0.1:27686`. The query URL is that base URL. Host is
`MOTEL_OTEL_HOST`, or the base URL hostname. Port is `MOTEL_OTEL_PORT` when
it is a positive integer, otherwise the base URL port, otherwise 80. Trace
and log exporter URLs default to that base with `v1/traces` and `v1/logs`.

`motel start`, and the daemon the TUI launches, build the listen address
from `MOTEL_OTEL_BASE_URL`, then `MOTEL_OTEL_QUERY_URL`, then
`http://127.0.0.1:27686`. A missing port becomes 27686. The spawned server
receives that listen address as its base URL, query URL, host, port, and
exporter URLs (the listen origin plus `/v1/traces` and `/v1/logs`). The
database file is resolved separately: `MOTEL_OTEL_DB_PATH`, or
`telemetry.sqlite` in the runtime directory.

Integer settings treat blank, non-numeric, and non-positive values as unset.
`MOTEL_OTEL_QUERY_CAPACITY` is capped at 64 and
`MOTEL_OTEL_QUERY_DEADLINE_MS` at 30000.

| Variable | Default | What it does |
| --- | --- | --- |
| `MOTEL_OTEL_BASE_URL` | `http://127.0.0.1:27686` | Resolved base URL and query URL. First choice in the fallback above. |
| `MOTEL_OTEL_QUERY_URL` | unset | Base URL when `MOTEL_OTEL_BASE_URL` is unset. The query URL equals the resolved base URL. |
| `MOTEL_OTEL_COLLECTOR_URL` | unset | Base URL only when both URLs above are unset. The managed daemon leaves it unused. |
| `MOTEL_OTEL_HOST` | base URL hostname (`127.0.0.1`) | Hostname the server binds. |
| `MOTEL_OTEL_PORT` | base URL port (`27686`) | Port the server binds. `src/config.ts` uses 80 when the URL has no port; the managed daemon uses 27686. |
| `MOTEL_OTEL_SERVICE_NAME` | `motel-otel-tui` | Name on motel's own exporter, and the CLI default service. A nonblank value is also the TUI's initial service. Blank keeps the remembered TUI service. |
| `MOTEL_OTEL_ENABLED` | `false` | Export motel's own traces and logs from the TUI and CLI. Blank, `0`, `false`, `no`, and `off` stay off; any other value turns it on. |
| `MOTEL_OTEL_EXPORTER_URL` | base URL + `/v1/traces` | Where that self-export posts spans. |
| `MOTEL_OTEL_LOGS_EXPORTER_URL` | base URL + `/v1/logs` | Where that self-export posts logs. |
| `MOTEL_RUNTIME_DIR` | `${XDG_STATE_HOME:-~/.local/state}/motel` | State directory: default database, daemon log, lock, and instance registry. |
| `MOTEL_OTEL_DB_PATH` | `$MOTEL_RUNTIME_DIR/telemetry.sqlite` | SQLite file. One shared database per machine unless this is set. |
| `MOTEL_URL` | unset | Base URL for the MCP client. When set, discovery uses it instead of the instance registry. |
| `MOTEL_OTEL_TRACE_LOOKBACK_MINUTES` | `1440` | Age window, in minutes, for service discovery and for store queries that omit a lookback. HTTP list and search routes send their own `lookback` (default 60 minutes, maximum 1440). |
| `MOTEL_OTEL_TRACE_LIMIT` | `100` | Trace count for the TUI and for CLI trace commands that omit a limit. HTTP list routes send their own `limit`. |
| `MOTEL_OTEL_LOG_LIMIT` | `80` | Log count for TUI service logs, TUI trace logs, and CLI log commands. HTTP log routes send their own `limit`. |
| `MOTEL_OTEL_QUERY_CAPACITY` | `8` (maximum 64) | Outstanding readonly queries per runtime. Overload is HTTP 503 `QUERY_OVERLOADED`. |
| `MOTEL_OTEL_QUERY_DEADLINE_MS` | `5000` (maximum 30000) | Queue plus startup deadline for one readonly query. Expiry is HTTP 504 `QUERY_DEADLINE`. |
| `MOTEL_OTEL_RETENTION_HOURS` | `168` | Age cutoff for completed traces and for logs. |
| `MOTEL_OTEL_MAX_DB_SIZE_MB` | `1024` | Active-data target in MB: `(page_count - freelist_count) * page_size`. Not a hard file-size cap. |
| `MOTEL_OTEL_RETENTION_TRACE_BATCH` | `100` | Completed traces marked per cleanup pass. |
| `MOTEL_OTEL_RETENTION_ROW_BATCH` | `1000` | Rows deleted per cleanup pass, split across traces and logs. Bounds row count, not the size of one field. |
| `MOTEL_OTEL_RETENTION_LOG_BATCH` | `5000` | Logs marked per cleanup pass. |
| `MOTEL_OTEL_RETENTION_INTERVAL_SECONDS` | `10` | Delay after an idle cleanup pass. Cleanup that is still making progress waits 100 ms. |

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

Queries use one readonly subprocess at a time, with FIFO admission capped at eight outstanding
requests by default (`MOTEL_OTEL_QUERY_CAPACITY`, maximum 64). The five-second deadline includes
queue and startup time (`MOTEL_OTEL_QUERY_DEADLINE_MS`, maximum 30000). Overload returns HTTP 503
with `code: "QUERY_OVERLOADED"`; expiry returns 504 with `code: "QUERY_DEADLINE"`; process failure
returns 503 with `code: "QUERY_UNAVAILABLE"`. Successful response shapes are unchanged.

Cancelling or expiring an executing query terminates its readonly process and waits for exit
before dispatching the next query. SQLite runs in a thread inside that process so an IPC-owner
disconnect can also terminate it if the daemon or TUI dies. Ingestion owns a separate worker.
The HTTP idle timeout exceeds the query deadline by five seconds. TUI refreshes share in-flight
loads, obsolete selections discard results, and facet values prefetch sequentially for two keys.
