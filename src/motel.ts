#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { CliOutput, Command } from "effect/unstable/cli"
import packageJson from "../package.json" with { type: "json" }
import { queryCommands } from "./cli.js"
import { applyManagedDaemonEnv, ensureManagedDaemon, getManagedDaemonStatus, stopManagedDaemon } from "./daemon.js"

const json = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const tui = Command.make("tui", {}, () =>
	Effect.gen(function*() {
		yield* applyManagedDaemonEnv
		yield* Effect.promise(() => import("./index.js"))
	}),
).pipe(Command.withDescription("Launch the telemetry TUI"))

const daemon = Command.make("daemon", {}, () =>
	ensureManagedDaemon.pipe(Effect.andThen(json)),
).pipe(
	Command.withAlias("start"),
	Command.withDescription("Ensure the managed telemetry daemon is running"),
)

const status = Command.make("status", {}, () =>
	getManagedDaemonStatus.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Print managed daemon status"))

const stop = Command.make("stop", {}, () =>
	stopManagedDaemon.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Stop the managed telemetry daemon"))

const restart = Command.make("restart", {}, () =>
	Effect.gen(function*() {
		yield* stopManagedDaemon
		yield* ensureManagedDaemon.pipe(Effect.andThen(json))
	}),
).pipe(Command.withDescription("Restart only the managed telemetry daemon"))

const server = Command.make("server", {}, () =>
	Effect.gen(function*() {
		yield* applyManagedDaemonEnv
		yield* Effect.promise(() => import("./server.js"))
	}),
).pipe(Command.withDescription("Run the telemetry server in the foreground"))

const mcp = Command.make("mcp", {}, () =>
	Effect.promise(() => import("./mcp.js")),
).pipe(Command.withDescription("Run the Motel MCP server over stdio"))

const motel = Command.make("motel", {}, () =>
	Effect.gen(function*() {
		yield* applyManagedDaemonEnv
		yield* Effect.promise(() => import("./index.js"))
	}),
).pipe(
	Command.withDescription("Local OpenTelemetry ingest and inspection"),
	Command.withSubcommands([tui, daemon, status, stop, restart, server, mcp, ...queryCommands]),
)

const defaultFormatter = CliOutput.defaultFormatter()
const output = CliOutput.layer({
	...defaultFormatter,
	formatVersion: (_, version) => version,
})

Command.run(motel, { version: packageJson.version }).pipe(
	Effect.provide(BunServices.layer),
	Effect.provide(output),
	BunRuntime.runMain,
)
