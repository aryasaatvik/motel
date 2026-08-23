#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { CliOutput, Command, Flag } from "effect/unstable/cli"
import packageJson from "../package.json" with { type: "json" }
import { queryCommands } from "./cli.js"
import { applyManagedDaemonEnv } from "./daemon.js"
import { createLaunchAgentManager, createMotelLifecycle } from "./launchAgent.js"

const json = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const tui = Command.make("tui", {}, () =>
	Effect.gen(function*() {
		yield* applyManagedDaemonEnv
		yield* Effect.promise(() => import("./index.js"))
	}),
).pipe(Command.withDescription("Launch the telemetry TUI"))

const lifecycle = createMotelLifecycle()

const daemon = Command.make("daemon", {}, () =>
	lifecycle.start.pipe(Effect.andThen(json)),
).pipe(
	Command.withAlias("start"),
	Command.withDescription("Ensure the managed telemetry daemon is running"),
)

const status = Command.make("status", {}, () =>
	lifecycle.status.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Print managed daemon status"))

const stop = Command.make("stop", {}, () =>
	lifecycle.stop.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Stop the managed telemetry daemon"))

const restart = Command.make("restart", {}, () =>
	lifecycle.restart.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Restart only the managed telemetry daemon"))

const serviceManager = createLaunchAgentManager()
const serviceInstall = Command.make("install", {
	replace: Flag.boolean("replace").pipe(Flag.withDefault(false)),
}, ({ replace }) =>
	serviceManager.install(replace).pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Install the per-user Motel LaunchAgent"))
const serviceStatus = Command.make("status", {}, () =>
	serviceManager.status.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Print per-user LaunchAgent and daemon status"))
const serviceUninstall = Command.make("uninstall", {}, () =>
	serviceManager.uninstall.pipe(Effect.andThen(json)),
).pipe(Command.withDescription("Unload and remove the per-user Motel LaunchAgent definition"))
const service = Command.make("service", {}, () =>
	Effect.fail(new Error("Specify service install, service status, or service uninstall.")),
).pipe(
	Command.withDescription("Manage the per-user Motel LaunchAgent"),
	Command.withSubcommands([serviceInstall, serviceStatus, serviceUninstall]),
)

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
	Command.withSubcommands([tui, daemon, status, stop, restart, service, server, mcp, ...queryCommands]),
)

const defaultFormatter = CliOutput.defaultFormatter()
const output = CliOutput.layer({
	...defaultFormatter,
	formatVersion: (_, version) => version,
})

Command.run(motel, { version: packageJson.version }).pipe(
	Effect.provide(Layer.mergeAll(BunServices.layer, output)),
	BunRuntime.runMain,
)
