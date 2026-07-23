import { Effect } from "effect"
import { createDaemonManager, type DaemonStatus } from "./daemon.js"
import { createLaunchAgentManager, createMotelLifecycle, usesLaunchAgentRuntime, type LaunchAgentManager, type MotelLifecycle } from "./launchAgent.js"
import { MOTEL_SERVICE_ID } from "./registry.js"

export type ConflictStatus = DaemonStatus & {
	readonly service: typeof MOTEL_SERVICE_ID
	readonly pid: number
	readonly workdir: string
	readonly reason: string
}

export const startDaemon = (lifecycle: MotelLifecycle = createMotelLifecycle()) => Effect.runPromise(lifecycle.start)

const parsePort = (url: string) => {
	try {
		const port = Number(new URL(url).port)
		return Number.isFinite(port) && port > 0 ? port : undefined
	} catch {
		return undefined
	}
}

export const stopConflictingDaemon = async (
	status: ConflictStatus,
	options: {
		readonly service?: LaunchAgentManager
		readonly createManager?: typeof createDaemonManager
	} = {},
) => {
	const service = options.service ?? createLaunchAgentManager()
	if (usesLaunchAgentRuntime() && service.available) {
		const serviceStatus = await Effect.runPromise(service.status).catch((error) => {
			throw new Error(`Refusing detached recovery until Motel LaunchAgent ownership can be inspected: ${error instanceof Error ? error.message : String(error)}`)
		})
		if (serviceStatus?.manager === "loaded" && serviceStatus.health.pid === status.pid) {
			await Effect.runPromise(service.stop)
			return
		}
	}
	const port = parsePort(status.url)
	const manager = (options.createManager ?? createDaemonManager)({
		workdir: status.workdir ?? undefined,
		databasePath: status.databasePath,
		port,
	})
	await Effect.runPromise(manager.stop)
}
