import { expect, test } from "bun:test"
import { Effect } from "effect"
import { startDaemon, stopConflictingDaemon } from "./startupLifecycle.js"
import type { DaemonManager, DaemonStatus } from "./daemon.js"
import type { LaunchAgentManager, LaunchAgentStatus, MotelLifecycle } from "./launchAgent.js"

test("startup lifecycle starts through the supervisor-aware lifecycle", async () => {
	const events: string[] = []
	const lifecycle = {
		start: Effect.sync(() => { events.push("lifecycle:start"); return {} }),
	} as unknown as MotelLifecycle
	await startDaemon(lifecycle)
	expect(events).toEqual(["lifecycle:start"])
})

const conflict = {
	running: true,
	managed: false,
	service: "motel-local-server" as const,
	pid: 321,
	url: "http://127.0.0.1:27686",
	databasePath: "/tmp/conflict.sqlite",
	workdir: "/tmp/conflict",
	startedAt: null,
	version: null,
	sameWorkdir: false,
	reason: "conflict",
	logPath: "/tmp/conflict.log",
	lockPath: "/tmp/conflict.lock",
	registryPid: 321,
}

const serviceStatus = (pid: number): LaunchAgentStatus => ({
	installed: true,
	configuration: "equivalent",
	configurationDetails: [],
	manager: "loaded",
	running: true,
	health: { ...conflict, pid } as DaemonStatus,
	registryIdentity: "verified",
	version: { cli: "0.2.6", server: "0.2.6", drift: false },
})

test("startup lifecycle boots out only the matching loaded LaunchAgent child", async () => {
	const events: string[] = []
	const service = {
		available: true,
		status: Effect.succeed(serviceStatus(conflict.pid)),
		stop: Effect.sync(() => { events.push("service:stop"); return serviceStatus(conflict.pid) }),
	} as unknown as LaunchAgentManager
	await stopConflictingDaemon(conflict, {
		service,
		createManager: () => { throw new Error("detached manager should not be used") },
	})
	expect(events).toEqual(["service:stop"])
})

test("startup lifecycle retains scoped detached recovery for a different conflict PID", async () => {
	const events: string[] = []
	const service = { available: true, status: Effect.succeed(serviceStatus(999)) } as unknown as LaunchAgentManager
	const manager = { stop: Effect.sync(() => { events.push("daemon:stop"); return {} }) } as unknown as DaemonManager
	await stopConflictingDaemon(conflict, { service, createManager: () => manager })
	expect(events).toEqual(["daemon:stop"])
})

test("startup lifecycle fails closed when LaunchAgent ownership cannot be inspected", async () => {
	const events: string[] = []
	const service = { available: true, status: Effect.fail(new Error("plist unavailable")) } as unknown as LaunchAgentManager
	const manager = { stop: Effect.sync(() => { events.push("daemon:stop"); return {} }) } as unknown as DaemonManager
	await expect(stopConflictingDaemon(conflict, { service, createManager: () => manager })).rejects.toThrow("Refusing detached recovery")
	expect(events).toEqual([])
})
