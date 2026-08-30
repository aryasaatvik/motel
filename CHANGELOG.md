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
