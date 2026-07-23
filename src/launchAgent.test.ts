import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createDaemonManager, type DaemonManager, type DaemonStatus } from "./daemon.js"
import {
	buildLaunchAgentSpec,
	compareLaunchAgent,
	createLaunchAgentManager,
	createMotelLifecycle,
	inspectLaunchAgentJson,
	renderLaunchAgentPlist,
	usesLaunchAgentRuntime,
	type LaunchAgentManager,
	type LaunchAgentOperations,
} from "./launchAgent.js"

const spec = buildLaunchAgentSpec({ home: "/Users/motel-test" })

const plistValue = () => ({
	Label: spec.label,
	ProgramArguments: [...spec.programArguments],
	WorkingDirectory: spec.workingDirectory,
	EnvironmentVariables: { ...spec.environment },
	StandardOutPath: spec.logPath,
	StandardErrorPath: spec.logPath,
	RunAtLoad: true,
	KeepAlive: true,
	ProcessType: "Background",
})

const daemonStatus = (overrides: Partial<DaemonStatus> = {}): DaemonStatus => ({
	running: true,
	managed: true,
	service: "motel-local-server",
	pid: 123,
	url: "http://127.0.0.1:27686",
	databasePath: `${spec.workingDirectory}/telemetry.sqlite`,
	workdir: spec.workingDirectory,
	startedAt: "2026-07-23T00:00:00.000Z",
	version: "0.2.6",
	sameWorkdir: true,
	reason: null,
	logPath: `${spec.workingDirectory}/daemon.log`,
	lockPath: `${spec.workingDirectory}/daemon.lock`,
	registryPid: 123,
	...overrides,
})

const makeHarness = (options: { readonly installed?: boolean; readonly missingExecutables?: readonly string[]; readonly plist?: Record<string, unknown>; readonly plutilExitCode?: number; readonly launchctlPrintExitCode?: number; readonly launchctlPrintStderr?: string; readonly bootoutExitCode?: number; readonly health?: DaemonStatus } = {}) => {
	let installed = options.installed ?? false
	let plist = options.plist ?? plistValue()
	const calls: Array<readonly string[]> = []
	const fileEvents: string[] = []
	const files = new Map<string, string>()
	const operations: LaunchAgentOperations = {
		platform: "darwin",
		exists: async (file) => file === spec.plistPath ? installed : !options.missingExecutables?.includes(file),
		readFile: async (file) => files.get(file) ?? "",
		mkdir: async () => {},
		writeFile: async (file, contents) => { fileEvents.push("write"); files.set(file, contents) },
		rename: async (_from, to) => { fileEvents.push("rename"); if (to === spec.plistPath) { installed = true; plist = plistValue() } },
		unlink: async (file) => { fileEvents.push("unlink"); if (file === spec.plistPath) installed = false; files.delete(file) },
		run: async (command, args) => {
			calls.push([command, ...args])
			if (command === "plutil") return { exitCode: options.plutilExitCode ?? 0, stdout: JSON.stringify(plist), stderr: "invalid plist" }
			if (command === "launchctl" && args[0] === "print") return { exitCode: options.launchctlPrintExitCode ?? 113, stdout: "", stderr: options.launchctlPrintStderr ?? "Could not find service" }
			if (command === "launchctl" && args[0] === "bootout") return { exitCode: options.bootoutExitCode ?? 0, stdout: "", stderr: "could not boot out" }
			return { exitCode: 0, stdout: "", stderr: "" }
		},
		getDaemonStatus: async () => options.health ?? daemonStatus(),
		version: "0.2.6",
	}
	return { calls, fileEvents, manager: createLaunchAgentManager(spec, operations) }
}

describe("LaunchAgent specification", () => {
	test("renders the locked per-user contract with XML-safe values", () => {
		const rendered = renderLaunchAgentPlist({ ...spec, label: "dev.motel<&\"'" })
		expect(rendered).toContain("dev.motel&lt;&amp;&quot;&apos;")
		expect(rendered).toContain(`<key>RunAtLoad</key>\n  <true/>`)
		expect(rendered).toContain(`<key>KeepAlive</key>\n  <true/>`)
		expect(spec.programArguments).toEqual(["/Users/motel-test/.bun/bin/bun", "/Users/motel-test/.bun/bin/motel", "server"])
		expect(spec.environment.MOTEL_DAEMON_INSTANCE_ID).toBe("launchd-user-agent")
		expect(spec.environment.MOTEL_RUNTIME_DIR).toBe("/Users/motel-test/.local/state/motel")
	})

	test("compares structural plist JSON and ignores formatting or unrelated keys", () => {
		const parsed = inspectLaunchAgentJson(JSON.stringify({ ...plistValue(), Comment: "formatting is not configuration" }))
		expect(compareLaunchAgent(parsed, spec)).toEqual({ kind: "equivalent" })
		const divergent = inspectLaunchAgentJson(JSON.stringify({ ...plistValue(), KeepAlive: false }))
		expect(compareLaunchAgent(divergent, spec)).toEqual({ kind: "divergent", fields: ["KeepAlive"] })
		expect(compareLaunchAgent(inspectLaunchAgentJson("not json"), spec).kind).toBe("malformed")
	})
})

describe("LaunchAgent lifecycle", () => {
	test("installs atomically in launchctl-safe order and is a no-op when equivalent", async () => {
		const harness = makeHarness()
		const installed = await Effect.runPromise(harness.manager.install(false))
		expect(installed.installed).toBe(true)
		expect(harness.calls.filter(([command]) => command === "launchctl")).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootstrap", spec.domain, spec.plistPath],
			["launchctl", "enable", spec.target],
			["launchctl", "kickstart", "-k", spec.target],
			["launchctl", "print", spec.target],
		])
		harness.calls.length = 0
		await Effect.runPromise(harness.manager.install(false))
		expect(harness.calls.filter(([command, action]) => command === "launchctl" && action !== "print")).toEqual([])
	})

	test("refuses a divergent definition unless replace is explicit", async () => {
		const harness = makeHarness({ installed: true, plist: { ...plistValue(), ProcessType: "Interactive" }, launchctlPrintExitCode: 0 })
		await expect(Effect.runPromise(harness.manager.install(false))).rejects.toThrow("ProcessType")
		expect(harness.calls.filter(([command]) => command === "launchctl")).toEqual([])
		harness.calls.length = 0
		await Effect.runPromise(harness.manager.install(true))
		expect(harness.calls.filter(([command]) => command === "launchctl")).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootout", spec.target],
			["launchctl", "bootstrap", spec.domain, spec.plistPath],
			["launchctl", "enable", spec.target],
			["launchctl", "kickstart", "-k", spec.target],
			["launchctl", "print", spec.target],
		])
	})

	test("validates locked Bun and Motel executable paths before mutating the service", async () => {
		const harness = makeHarness({ missingExecutables: [spec.programArguments[1]!] })
		await expect(Effect.runPromise(harness.manager.install(false))).rejects.toThrow(spec.programArguments[1]!)
		expect(harness.fileEvents).toEqual([])
		expect(harness.calls).toEqual([])
	})

	test("reports a plutil parse failure as a malformed configuration diagnostic", async () => {
		const harness = makeHarness({ installed: true, plutilExitCode: 1, launchctlPrintExitCode: 113 })
		const status = await Effect.runPromise(harness.manager.status)
		expect(status.configuration).toBe("malformed")
		expect(status.configurationDetails).toEqual(["invalid plist"])
		expect(status.manager).toBe("not-loaded")
	})

	test("reports config, manager, health, registry, and version state without contaminating JSON", async () => {
		const harness = makeHarness({ installed: true, launchctlPrintExitCode: 113, health: daemonStatus({ managed: false, version: "0.2.5" }) })
		const status = await Effect.runPromise(harness.manager.status)
		expect(status).toMatchObject({
			installed: true,
			manager: "not-loaded",
			running: true,
			registryIdentity: "unverified",
			version: { cli: "0.2.6", server: "0.2.5", drift: true },
		})
	})

	test("uninstall only unloads and removes the plist", async () => {
		const harness = makeHarness({ installed: true, launchctlPrintExitCode: 0 })
		expect(await Effect.runPromise(harness.manager.uninstall)).toEqual({ removed: true })
		expect(harness.calls).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootout", spec.target],
		])
	})

	test("does not replace or remove a loaded job after bootout failure", async () => {
		const replacement = makeHarness({ installed: true, plist: { ...plistValue(), ProcessType: "Interactive" }, launchctlPrintExitCode: 0, bootoutExitCode: 1 })
		await expect(Effect.runPromise(replacement.manager.install(true))).rejects.toThrow("could not boot out")
		expect(replacement.fileEvents).toEqual([])

		const removal = makeHarness({ installed: true, launchctlPrintExitCode: 0, bootoutExitCode: 1 })
		await expect(Effect.runPromise(removal.manager.uninstall)).rejects.toThrow("could not boot out")
		expect(removal.fileEvents).toEqual([])
	})

	test("keeps uninstall a no-op when neither plist nor job is present", async () => {
		const harness = makeHarness({ installed: false, launchctlPrintExitCode: 113 })
		expect(await Effect.runPromise(harness.manager.uninstall)).toEqual({ removed: false })
		expect(harness.fileEvents).toEqual([])
	})

	test("bootstraps an unloaded service before restarting it", async () => {
		const harness = makeHarness({ installed: true, launchctlPrintExitCode: 113 })
		await Effect.runPromise(harness.manager.restart)
		expect(harness.calls.filter(([command]) => command === "launchctl")).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootstrap", spec.domain, spec.plistPath],
			["launchctl", "kickstart", "-k", spec.target],
			["launchctl", "print", spec.target],
		])
	})

	test("uninstalls a loaded orphan job even when its plist is already absent", async () => {
		const harness = makeHarness({ installed: false, launchctlPrintExitCode: 0 })
		expect(await Effect.runPromise(harness.manager.uninstall)).toEqual({ removed: true })
		expect(harness.calls).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootout", spec.target],
		])
	})

	test("requires replace and bootout before overwriting a loaded orphan job", async () => {
		const harness = makeHarness({ installed: false, launchctlPrintExitCode: 0 })
		await expect(Effect.runPromise(harness.manager.install(false))).rejects.toThrow("--replace")
		expect(harness.fileEvents).toEqual([])
		harness.calls.length = 0
		await Effect.runPromise(harness.manager.install(true))
		expect(harness.calls.filter(([command]) => command === "launchctl")).toEqual([
			["launchctl", "print", spec.target],
			["launchctl", "bootout", spec.target],
			["launchctl", "bootstrap", spec.domain, spec.plistPath],
			["launchctl", "enable", spec.target],
			["launchctl", "kickstart", "-k", spec.target],
			["launchctl", "print", spec.target],
		])
	})

	test("reports unknown launchctl inspection and refuses mutation", async () => {
		const harness = makeHarness({ installed: true, plist: { ...plistValue(), ProcessType: "Interactive" }, launchctlPrintExitCode: 1, launchctlPrintStderr: "permission denied" })
		expect((await Effect.runPromise(harness.manager.status)).manager).toBe("unknown")
		await expect(Effect.runPromise(harness.manager.install(true))).rejects.toThrow("Unable to determine")
		expect(harness.fileEvents).toEqual([])

		const equivalent = makeHarness({ installed: true, launchctlPrintExitCode: 1, launchctlPrintStderr: "permission denied" })
		await expect(Effect.runPromise(equivalent.manager.start)).rejects.toThrow("Unable to determine")
		await expect(Effect.runPromise(equivalent.manager.stop)).rejects.toThrow("Unable to determine")
		await expect(Effect.runPromise(equivalent.manager.restart)).rejects.toThrow("Unable to determine")
		await expect(Effect.runPromise(equivalent.manager.uninstall)).rejects.toThrow("Unable to determine")
		expect(equivalent.fileEvents).toEqual([])
	})

	test("fails service commands on non-macOS without attempting launchctl", async () => {
		const harness = makeHarness()
		const linuxManager = createLaunchAgentManager(spec, {
			...({
				platform: "linux",
				exists: async () => false,
				readFile: async () => "",
				mkdir: async () => {},
				writeFile: async () => {},
				rename: async () => {},
				unlink: async () => {},
				run: async (command: string, args: readonly string[]) => {
					harness.calls.push([command, ...args])
					return { exitCode: 0, stdout: "", stderr: "" }
				},
				getDaemonStatus: async () => daemonStatus(),
				version: "0.2.6",
			} satisfies LaunchAgentOperations),
		})
		await expect(Effect.runPromise(linuxManager.status)).rejects.toThrow("only on macOS")
		expect(harness.calls).toEqual([])
	})
})

const fakeService = (input: { readonly installed: boolean; readonly configuration?: "missing" | "equivalent" | "divergent" | "malformed"; readonly manager?: "loaded" | "not-loaded" | "unknown" }, events: string[]): LaunchAgentManager => {
	const status = Effect.succeed({
		installed: input.installed,
		configuration: input.configuration ?? "equivalent",
		configurationDetails: [],
		manager: input.manager ?? "loaded",
		running: true,
		health: daemonStatus(),
		registryIdentity: "verified" as const,
		version: { cli: "0.2.6", server: "0.2.6", drift: false },
	})
	return {
		available: true,
		inspect: Effect.succeed({ kind: "missing" as const }),
		status,
		install: () => status,
		uninstall: Effect.succeed({ removed: true }),
		start: Effect.sync(() => { events.push("service:start"); return Effect.runSync(status) }),
		stop: Effect.sync(() => { events.push("service:stop"); return Effect.runSync(status) }),
		restart: Effect.sync(() => { events.push("service:restart"); return Effect.runSync(status) }),
	}
}

describe("supervisor-aware top-level lifecycle", () => {
	test("routes installed services to launchd actions rather than the detached manager", async () => {
		const events: string[] = []
		const daemon = {
			applyEnv: Effect.void,
			getStatus: Effect.sync(() => { events.push("daemon:status"); return daemonStatus() }),
			ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
			stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
		} satisfies DaemonManager
		const lifecycle = createMotelLifecycle({ service: fakeService({ installed: true }, events), daemon })
		await Effect.runPromise(lifecycle.start)
		await Effect.runPromise(lifecycle.stop)
		await Effect.runPromise(lifecycle.restart)
		expect(events).toEqual(["service:start", "service:stop", "service:restart"])
	})

	test("keeps detached-manager lifecycle when no service definition is installed", async () => {
		const events: string[] = []
		const daemon = {
			applyEnv: Effect.void,
			getStatus: Effect.sync(() => { events.push("daemon:status"); return daemonStatus() }),
			ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
			stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
		} satisfies DaemonManager
		const lifecycle = createMotelLifecycle({ service: fakeService({ installed: false, configuration: "missing", manager: "not-loaded" }, events), daemon })
		await Effect.runPromise(lifecycle.restart)
		expect(events).toEqual(["daemon:stop", "daemon:start"])
	})

	test("never falls through to PID control for divergent definitions or loaded orphan jobs", async () => {
		for (const serviceState of [
			{ installed: false, configuration: "divergent" as const, manager: "not-loaded" as const },
			{ installed: false, configuration: "missing" as const, manager: "loaded" as const },
			{ installed: false, configuration: "missing" as const, manager: "unknown" as const },
		]) {
			const events: string[] = []
			const daemon = {
				applyEnv: Effect.void,
				getStatus: Effect.succeed(daemonStatus()),
				ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
				stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
			} satisfies DaemonManager
			const lifecycle = createMotelLifecycle({ service: fakeService(serviceState, events), daemon })
			await expect(Effect.runPromise(lifecycle.stop)).rejects.toThrow("LaunchAgent")
			expect(events).toEqual([])
		}
	})

	test("uses detached management for an explicitly isolated runtime without consulting the LaunchAgent", async () => {
		const events: string[] = []
		const daemon = {
			applyEnv: Effect.void,
			getStatus: Effect.succeed(daemonStatus()),
			ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
			stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
		} satisfies DaemonManager
		const lifecycle = createMotelLifecycle({
			service: fakeService({ installed: true }, events),
			daemon,
			runtimeDirectory: "/tmp/motel-release-isolation",
		})
		await Effect.runPromise(lifecycle.stop)
		expect(events).toEqual(["daemon:stop"])
		expect(usesLaunchAgentRuntime({ runtimeDirectory: "/tmp/motel-release-isolation" })).toBe(false)
	})

	test("uses detached management for every non-global effective daemon identity", () => {
		expect(usesLaunchAgentRuntime({ environment: {} })).toBe(true)
		for (const options of [
			{ stateHome: "/tmp/motel-xdg" },
			{ runtimeDirectory: "/tmp/motel-runtime" },
			{ databasePath: "/tmp/motel.sqlite" },
			{ baseUrl: "http://127.0.0.1:27687" },
			{ queryUrl: "http://127.0.0.1:27687" },
			{ host: "0.0.0.0" },
			{ port: 27687 },
		]) expect(usesLaunchAgentRuntime({ environment: {}, ...options })).toBe(false)
	})

	test("never consults the global LaunchAgent for a non-global top-level lifecycle identity", async () => {
		for (const options of [
			{ stateHome: "/tmp/motel-xdg" },
			{ databasePath: "/tmp/motel.sqlite" },
			{ baseUrl: "http://127.0.0.1:27687" },
			{ queryUrl: "http://127.0.0.1:27687" },
			{ host: "0.0.0.0" },
			{ port: 27687 },
		]) {
			const events: string[] = []
			const daemon = {
				applyEnv: Effect.void,
				getStatus: Effect.succeed(daemonStatus()),
				ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
				stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
			} satisfies DaemonManager
			const original = fakeService({ installed: true }, events)
			const service = {
				...original,
				status: Effect.sync(() => {
					events.push("service:status")
					return Effect.runSync(original.status)
				}),
			}
			await Effect.runPromise(createMotelLifecycle({ service, daemon, environment: {}, ...options }).stop)
			expect(events).toEqual(["daemon:stop"])
		}
	})

	test("uses the detached manager on a non-macOS host without consulting launchctl", async () => {
		const events: string[] = []
		const daemon = {
			applyEnv: Effect.void,
			getStatus: Effect.succeed(daemonStatus()),
			ensure: Effect.sync(() => { events.push("daemon:start"); return daemonStatus() }),
			stop: Effect.sync(() => { events.push("daemon:stop"); return daemonStatus() }),
		} satisfies DaemonManager
		const service = { ...fakeService({ installed: false, configuration: "missing", manager: "not-loaded" }, events), available: false }
		await Effect.runPromise(createMotelLifecycle({ service, daemon }).restart)
		expect(events).toEqual(["daemon:stop", "daemon:start"])
	})
})
