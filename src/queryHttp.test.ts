import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDaemonManager } from "./daemon.ts"

test("HTTP overload and deadline responses are typed and leave ingestion usable", async () => {
	const root = mkdtempSync(join(tmpdir(), "motel-query-http-"))
	const port = 38000 + Math.floor(Math.random() * 1000)
	const manager = createDaemonManager({ runtimeDir: root, databasePath: join(root, "db.sqlite"), port })
	const previousCapacity = process.env.MOTEL_OTEL_QUERY_CAPACITY
	const previousDeadline = process.env.MOTEL_OTEL_QUERY_DEADLINE_MS
	try {
		process.env.MOTEL_OTEL_QUERY_CAPACITY = "1"
		process.env.MOTEL_OTEL_QUERY_DEADLINE_MS = "25"
		await Effect.runPromise(manager.ensure)
		const responses = await Promise.all([1, 2].map(async () => {
			const response = await fetch(`http://127.0.0.1:${port}/api/services`)
			return { status: response.status, body: await response.json() as { code: string } }
		}))
		expect(responses.map((response) => response.status).sort()).toEqual([503, 504])
		expect(responses.map((response) => response.body.code).sort()).toEqual(["QUERY_DEADLINE", "QUERY_OVERLOADED"])
		expect((await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(200)
		expect((await fetch(`http://127.0.0.1:${port}/api/readiness`)).status).toBe(200)
	} finally {
		if (previousCapacity === undefined) delete process.env.MOTEL_OTEL_QUERY_CAPACITY
		else process.env.MOTEL_OTEL_QUERY_CAPACITY = previousCapacity
		if (previousDeadline === undefined) delete process.env.MOTEL_OTEL_QUERY_DEADLINE_MS
		else process.env.MOTEL_OTEL_QUERY_DEADLINE_MS = previousDeadline
		await Effect.runPromise(manager.stop)
		rmSync(root, { recursive: true, force: true })
	}
}, 15000)
