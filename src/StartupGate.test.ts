import { expect, test } from "bun:test"
import { Effect } from "effect"
import { startDaemon } from "./StartupGate.js"
import type { MotelLifecycle } from "./launchAgent.js"

test("StartupGate starts through the supervisor-aware lifecycle", async () => {
	const events: string[] = []
	const lifecycle = {
		start: Effect.sync(() => { events.push("lifecycle:start"); return {} }),
	} as unknown as MotelLifecycle
	await startDaemon(lifecycle)
	expect(events).toEqual(["lifecycle:start"])
})
