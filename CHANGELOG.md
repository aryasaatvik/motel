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
