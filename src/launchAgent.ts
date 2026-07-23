import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { createDaemonManager, type DaemonManager, type DaemonStatus } from "./daemon.js"
import { MOTEL_VERSION } from "./registry.js"

export const LAUNCH_AGENT_LABEL = "dev.motel.local-server"
export const LAUNCH_AGENT_INSTANCE_ID = "launchd-user-agent"

export type LaunchAgentSpec = {
	readonly label: string
	readonly domain: string
	readonly target: string
	readonly plistPath: string
	readonly workingDirectory: string
	readonly logPath: string
	readonly programArguments: readonly string[]
	readonly environment: Readonly<Record<string, string>>
	readonly runAtLoad: true
	readonly keepAlive: true
	readonly processType: "Background"
}

type PlistObject = Readonly<Record<string, unknown>>

export type LaunchAgentInspection =
	| { readonly kind: "missing" }
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "valid"; readonly value: PlistObject }

export type LaunchAgentComparison =
	| { readonly kind: "equivalent" }
	| { readonly kind: "divergent"; readonly fields: readonly string[] }
	| { readonly kind: "malformed"; readonly message: string }

export type CommandResult = {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

export type LaunchAgentOperations = {
	readonly platform: NodeJS.Platform
	readonly exists: (file: string) => Promise<boolean>
	readonly readFile: (file: string) => Promise<string>
	readonly mkdir: (directory: string) => Promise<void>
	readonly writeFile: (file: string, contents: string) => Promise<void>
	readonly rename: (from: string, to: string) => Promise<void>
	readonly unlink: (file: string) => Promise<void>
	readonly run: (command: string, args: readonly string[]) => Promise<CommandResult>
	readonly getDaemonStatus: () => Promise<DaemonStatus>
	readonly version: string
}

export class LaunchAgentError extends Error {
	readonly _tag = "LaunchAgentError"
}

const xmlEscape = (value: string) => value
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&apos;")

const xmlString = (value: string) => `<string>${xmlEscape(value)}</string>`

const xmlArray = (values: readonly string[]) => `<array>\n${values.map((value) => `      ${xmlString(value)}`).join("\n")}\n    </array>`

const xmlEnvironment = (environment: Readonly<Record<string, string>>) => `<dict>\n${Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      ${xmlString(value)}`).join("\n")}\n    </dict>`

export const buildLaunchAgentSpec = (options: { readonly home?: string; readonly stateDirectory?: string } = {}): LaunchAgentSpec => {
	const home = options.home ?? os.homedir()
	const workingDirectory = options.stateDirectory ?? path.join(home, ".local", "state", "motel")
	const bunDirectory = path.join(home, ".bun", "bin")
	const label = LAUNCH_AGENT_LABEL
	return {
		label,
		domain: `gui/${process.getuid?.() ?? 0}`,
		target: `gui/${process.getuid?.() ?? 0}/${label}`,
		plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
		workingDirectory,
		logPath: path.join(workingDirectory, "launchd.log"),
		programArguments: [path.join(bunDirectory, "bun"), path.join(bunDirectory, "motel"), "server"],
		environment: {
			HOME: home,
			MOTEL_DAEMON_INSTANCE_ID: LAUNCH_AGENT_INSTANCE_ID,
			MOTEL_OTEL_BASE_URL: "http://127.0.0.1:27686",
			MOTEL_OTEL_DB_PATH: path.join(workingDirectory, "telemetry.sqlite"),
			MOTEL_OTEL_HOST: "127.0.0.1",
			MOTEL_OTEL_PORT: "27686",
			MOTEL_OTEL_QUERY_URL: "http://127.0.0.1:27686",
			MOTEL_RUNTIME_DIR: workingDirectory,
			PATH: `${bunDirectory}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
		},
		runAtLoad: true,
		keepAlive: true,
		processType: "Background",
	}
}

export const renderLaunchAgentPlist = (spec: LaunchAgentSpec) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(spec.label)}
  <key>ProgramArguments</key>
  ${xmlArray(spec.programArguments)}
  <key>WorkingDirectory</key>
  ${xmlString(spec.workingDirectory)}
  <key>EnvironmentVariables</key>
  ${xmlEnvironment(spec.environment)}
  <key>StandardOutPath</key>
  ${xmlString(spec.logPath)}
  <key>StandardErrorPath</key>
  ${xmlString(spec.logPath)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  ${xmlString(spec.processType)}
</dict>
</plist>
`

const asRecord = (value: unknown): PlistObject | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as PlistObject : null

export const inspectLaunchAgentJson = (source: string): LaunchAgentInspection => {
	try {
		const parsed = JSON.parse(source) as unknown
		const value = asRecord(parsed)
		return value === null ? { kind: "malformed", message: "plist must be a dictionary." } : { kind: "valid", value }
	} catch (error) {
		return { kind: "malformed", message: error instanceof Error ? error.message : String(error) }
	}
}

const sameStringArray = (actual: unknown, expected: readonly string[]) =>
	Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index])

export const compareLaunchAgent = (inspection: LaunchAgentInspection, spec: LaunchAgentSpec): LaunchAgentComparison => {
	if (inspection.kind === "missing") return { kind: "divergent", fields: ["plist"] }
	if (inspection.kind === "malformed") return inspection
	const value = inspection.value
	const fields: string[] = []
	if (value.Label !== spec.label) fields.push("Label")
	if (!sameStringArray(value.ProgramArguments, spec.programArguments)) fields.push("ProgramArguments")
	if (value.WorkingDirectory !== spec.workingDirectory) fields.push("WorkingDirectory")
	if (value.StandardOutPath !== spec.logPath) fields.push("StandardOutPath")
	if (value.StandardErrorPath !== spec.logPath) fields.push("StandardErrorPath")
	if (value.RunAtLoad !== true) fields.push("RunAtLoad")
	if (value.KeepAlive !== true) fields.push("KeepAlive")
	if (value.ProcessType !== spec.processType) fields.push("ProcessType")
	const environment = asRecord(value.EnvironmentVariables)
	if (environment === null || Object.entries(spec.environment).some(([key, expected]) => environment[key] !== expected)) fields.push("EnvironmentVariables")
	return fields.length === 0 ? { kind: "equivalent" } : { kind: "divergent", fields }
}

const defaultOperations = (): LaunchAgentOperations => {
	const daemon = createDaemonManager()
	return {
		exists: async (file) => fs.access(file).then(() => true).catch(() => false),
		readFile: (file) => fs.readFile(file, "utf8"),
		mkdir: (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined),
		writeFile: (file, contents) => fs.writeFile(file, contents, "utf8"),
		rename: fs.rename,
		unlink: (file) => fs.rm(file, { force: true }),
		run: async (command, args) => {
			const process = Bun.spawn({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe" })
			const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
			return { exitCode, stdout, stderr }
		},
		getDaemonStatus: () => Effect.runPromise(daemon.getStatus),
		version: MOTEL_VERSION,
		platform: process.platform,
	}
}

const required = async (operations: LaunchAgentOperations, command: string, args: readonly string[]) => {
	const result = await operations.run(command, args)
	if (result.exitCode !== 0) throw new LaunchAgentError(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`)
	return result
}

const optional = async (operations: LaunchAgentOperations, command: string, args: readonly string[]) => operations.run(command, args)

const readInspection = async (operations: LaunchAgentOperations, spec: LaunchAgentSpec): Promise<LaunchAgentInspection> => {
	if (!await operations.exists(spec.plistPath)) return { kind: "missing" }
	const result = await optional(operations, "plutil", ["-convert", "json", "-o", "-", spec.plistPath])
	if (result.exitCode !== 0) return { kind: "malformed", message: result.stderr.trim() || result.stdout.trim() || "plutil could not parse the plist." }
	return inspectLaunchAgentJson(result.stdout)
}

const writeAtomically = async (operations: LaunchAgentOperations, spec: LaunchAgentSpec) => {
	const directory = path.dirname(spec.plistPath)
	const temporary = path.join(directory, `.${spec.label}.${crypto.randomUUID()}.plist`)
	await operations.mkdir(directory)
	try {
		await operations.writeFile(temporary, renderLaunchAgentPlist(spec))
		await operations.rename(temporary, spec.plistPath)
	} catch (error) {
		await operations.unlink(temporary).catch(() => undefined)
		throw error
	}
}

export type LaunchAgentStatus = {
	readonly installed: boolean
	readonly configuration: "missing" | "equivalent" | "divergent" | "malformed"
	readonly configurationDetails: readonly string[]
	readonly manager: "loaded" | "not-loaded" | "unknown"
	readonly running: boolean
	readonly health: DaemonStatus
	readonly registryIdentity: "verified" | "unverified" | "missing"
	readonly version: { readonly cli: string; readonly server: string | null; readonly drift: boolean | null }
}

export type LaunchAgentManager = {
	readonly available: boolean
	readonly inspect: Effect.Effect<LaunchAgentInspection, LaunchAgentError>
	readonly status: Effect.Effect<LaunchAgentStatus, LaunchAgentError>
	readonly install: (replace: boolean) => Effect.Effect<LaunchAgentStatus, LaunchAgentError>
	readonly uninstall: Effect.Effect<{ readonly removed: boolean }, LaunchAgentError>
	readonly start: Effect.Effect<LaunchAgentStatus, LaunchAgentError>
	readonly stop: Effect.Effect<LaunchAgentStatus, LaunchAgentError>
	readonly restart: Effect.Effect<LaunchAgentStatus, LaunchAgentError>
}

export const createLaunchAgentManager = (spec = buildLaunchAgentSpec(), supplied?: Partial<LaunchAgentOperations>): LaunchAgentManager => {
	const operations = { ...defaultOperations(), ...supplied }
	const available = operations.platform === "darwin"
	const macOnly = <A>(effect: Effect.Effect<A, LaunchAgentError>) =>
		available ? effect : Effect.fail(new LaunchAgentError("Motel service management is available only on macOS LaunchAgent hosts."))
	const inspect = Effect.tryPromise({ try: () => readInspection(operations, spec), catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)) })
	const status = Effect.tryPromise({
		try: async (): Promise<LaunchAgentStatus> => {
			const inspection = await readInspection(operations, spec)
			const comparison = compareLaunchAgent(inspection, spec)
			const managerResult = await optional(operations, "launchctl", ["print", spec.target])
			const health = await operations.getDaemonStatus()
			return {
				installed: comparison.kind === "equivalent",
				configuration: inspection.kind === "missing" ? "missing" : comparison.kind,
				configurationDetails: comparison.kind === "divergent" ? comparison.fields : comparison.kind === "malformed" ? [comparison.message] : [],
				manager: managerResult.exitCode === 0 ? "loaded" : "not-loaded",
				running: health.running,
				health,
				registryIdentity: health.registryPid === null ? "missing" : health.managed ? "verified" : "unverified",
				version: { cli: operations.version, server: health.version, drift: health.version === null ? null : health.version !== operations.version },
			}
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	const install = (replace: boolean) => Effect.tryPromise({
		try: async () => {
			const inspection = await readInspection(operations, spec)
			const comparison = compareLaunchAgent(inspection, spec)
			if (comparison.kind === "equivalent") return Effect.runPromise(status)
			if (comparison.kind === "malformed" && !replace) throw new LaunchAgentError(`Existing service plist is malformed: ${comparison.message}. Re-run with --replace to replace it.`)
			if (comparison.kind === "divergent" && inspection.kind !== "missing" && !replace) throw new LaunchAgentError(`Existing service plist diverges in ${comparison.fields.join(", ")}. Re-run with --replace to replace it.`)
			if (inspection.kind !== "missing") await optional(operations, "launchctl", ["bootout", spec.domain, spec.plistPath])
			await operations.mkdir(spec.workingDirectory)
			await writeAtomically(operations, spec)
			await required(operations, "launchctl", ["bootstrap", spec.domain, spec.plistPath])
			await required(operations, "launchctl", ["enable", spec.target])
			await required(operations, "launchctl", ["kickstart", "-k", spec.target])
			return Effect.runPromise(status)
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	const start = Effect.tryPromise({
		try: async () => {
			const inspection = await readInspection(operations, spec)
			if (compareLaunchAgent(inspection, spec).kind !== "equivalent") throw new LaunchAgentError("Cannot start an absent, malformed, or divergent Motel service.")
			const printed = await optional(operations, "launchctl", ["print", spec.target])
			if (printed.exitCode !== 0) await required(operations, "launchctl", ["bootstrap", spec.domain, spec.plistPath])
			await required(operations, "launchctl", ["kickstart", "-k", spec.target])
			return Effect.runPromise(status)
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	const stop = Effect.tryPromise({
		try: async () => {
			const inspection = await readInspection(operations, spec)
			if (compareLaunchAgent(inspection, spec).kind !== "equivalent") throw new LaunchAgentError("Cannot stop an absent, malformed, or divergent Motel service.")
			await optional(operations, "launchctl", ["bootout", spec.domain, spec.plistPath])
			return Effect.runPromise(status)
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	const restart = Effect.tryPromise({
		try: async () => {
			const inspection = await readInspection(operations, spec)
			if (compareLaunchAgent(inspection, spec).kind !== "equivalent") throw new LaunchAgentError("Cannot restart an absent, malformed, or divergent Motel service.")
			await required(operations, "launchctl", ["kickstart", "-k", spec.target])
			return Effect.runPromise(status)
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	const uninstall = Effect.tryPromise({
		try: async () => {
			const hasPlist = await operations.exists(spec.plistPath)
			const managerResult = await optional(operations, "launchctl", ["print", spec.target])
			if (hasPlist) {
				await optional(operations, "launchctl", ["bootout", spec.domain, spec.plistPath])
				await operations.unlink(spec.plistPath)
				return { removed: true }
			}
			if (managerResult.exitCode === 0) {
				await optional(operations, "launchctl", ["bootout", spec.target])
				return { removed: true }
			}
			return { removed: false }
		},
		catch: (error) => error instanceof LaunchAgentError ? error : new LaunchAgentError(error instanceof Error ? error.message : String(error)),
	})
	return {
		available,
		inspect: macOnly(inspect),
		status: macOnly(status),
		install: (replace) => macOnly(install(replace)),
		uninstall: macOnly(uninstall),
		start: macOnly(start),
		stop: macOnly(stop),
		restart: macOnly(restart),
	}
}

export const isInstalledLaunchAgent = (manager = createLaunchAgentManager()) => manager.status.pipe(Effect.map((status) => status.installed))

export type MotelLifecycle = {
	readonly start: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
	readonly status: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
	readonly stop: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
	readonly restart: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
}

/**
 * Routes the public daemon lifecycle before it reaches the detached manager.
 * A KeepAlive-managed launchd child is never directly signalled by Motel.
 */
export const createMotelLifecycle = (options: { readonly service?: LaunchAgentManager; readonly daemon?: DaemonManager } = {}): MotelLifecycle => {
	const service = options.service ?? createLaunchAgentManager()
	const daemon = options.daemon ?? createDaemonManager()
	const route = (
		status: LaunchAgentStatus,
		supervised: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>,
		detached: Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>,
	) => {
		if (status.configuration === "missing" && status.manager !== "loaded") return detached
		if (!status.installed) {
			return Effect.fail(new LaunchAgentError(
				status.manager === "loaded"
					? "Motel has a loaded LaunchAgent that does not match the expected service definition. Run `motel service uninstall` or repair it with `motel service install --replace`."
					: "Motel has a present LaunchAgent definition that does not match the expected service contract. Inspect `motel service status` and use `motel service install --replace` if replacement is intended.",
			))
		}
		return supervised
	}
	return {
		status: service.available
			? service.status.pipe(Effect.flatMap((status): Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never> => status.configuration === "missing" && status.manager !== "loaded" ? daemon.getStatus : Effect.succeed(status))) as Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
			: daemon.getStatus,
		start: service.available
			? service.status.pipe(Effect.flatMap((status): Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never> => route(status, service.start, daemon.ensure))) as Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
			: daemon.ensure,
		stop: service.available
			? service.status.pipe(Effect.flatMap((status): Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never> => route(status, service.stop, daemon.stop))) as Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
			: daemon.stop,
		restart: service.available
			? service.status.pipe(Effect.flatMap((status): Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never> => route(status, service.restart, Effect.gen(function*() {
			yield* daemon.stop
			return yield* daemon.ensure
		})))) as Effect.Effect<DaemonStatus | LaunchAgentStatus, unknown, never>
			: Effect.gen(function*() {
				yield* daemon.stop
				return yield* daemon.ensure
			}),
	}
}
