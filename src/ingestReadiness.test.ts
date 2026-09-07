import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createDaemonManager } from "./daemon.ts"
import { IngestProgress, type IngestReadiness } from "./ingestReadiness.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("idle readiness, overload age, empty commits, and terminal failure are distinct", () => {
	const progress = new IngestProgress()
	expect(progress.snapshot().state).toBe("starting")
	progress.receive({ _tag: "ready" })
	expect(progress.snapshot(Date.now() + 86_400_000).state).toBe("ready")
	const finish = progress.begin(42, 100)
	expect(progress.snapshot(5100)).toMatchObject({ state: "overloaded", outstandingBytes: 42, outstandingRequests: 1 })
	progress.receive({ _tag: "commit", records: 0, at: 500 })
	expect(progress.snapshot().lastCommitAt).toBeNull()
	finish()
	finish()
	expect(progress.snapshot()).toMatchObject({ state: "ready", outstandingBytes: 0, outstandingRequests: 0 })
	progress.fail()
	progress.receive({ _tag: "ready" })
	expect(progress.snapshot().state).toBe("failed")
})

test("cached readiness bypasses a blocked writer and acknowledgement follows commit", async () => {
	const runtimeDir = mkdtempSync(join(tmpdir(), "motel-readiness-"))
	const databasePath = join(runtimeDir, "telemetry.sqlite")
	const port = 31000 + Math.floor(Math.random() * 2000)
	const manager = createDaemonManager({ runtimeDir, databasePath, port })
	let lock: Database | undefined
	try {
		await Effect.runPromise(manager.ensure)
		const base = `http://127.0.0.1:${port}`
		const readiness = async () => {
			const response = await fetch(`${base}/api/readiness`, { signal: AbortSignal.timeout(1500) })
			return await response.json() as IngestReadiness
		}
		expect((await readiness()).state).toBe("ready")
		lock = new Database(databasePath)
		lock.exec("BEGIN IMMEDIATE")
		const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "readiness-test" } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "commit barrier" } }] }] }] })
		let acknowledged = false
		const ingestion = fetch(`${base}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body }).then(async (response) => {
			expect(response.status).toBe(200)
			acknowledged = true
			return response.json()
		})
		await sleep(150)
		const snapshot = await readiness()
		expect(snapshot.outstandingRequests).toBe(1)
		expect(snapshot.outstandingBytes).toBe(Buffer.byteLength(body))
		expect(acknowledged).toBe(false)
		expect(lock.query("SELECT count(*) AS n FROM logs WHERE body = 'commit barrier'").get()).toEqual({ n: 0 })
		lock.exec("COMMIT")
		expect(await ingestion).toEqual({ insertedLogs: 1 })
		for (let i = 0; i < 50 && (await readiness()).committedRecords === 0; i++) await sleep(10)
		expect(await readiness()).toMatchObject({ state: "ready", outstandingRequests: 0, outstandingBytes: 0, committedRecords: 1 })
		expect(lock.query("SELECT count(*) AS n FROM logs WHERE body = 'commit barrier'").get()).toEqual({ n: 1 })
		expect((await Effect.runPromise(manager.getStatus)).readiness?.state).toBe("ready")
	} finally {
		try { lock?.exec("ROLLBACK") } catch { /* The successful path committed. */ }
		lock?.close()
		await Effect.runPromise(manager.stop)
		rmSync(runtimeDir, { recursive: true, force: true })
	}
}, 30000)

test("a writer bootstrap failure is reported without mistaking liveness for readiness", async () => {
	const root = mkdtempSync(join(tmpdir(), "motel-writer-failure-"))
	const port = 35000 + Math.floor(Math.random() * 1000)
	const child = Bun.spawn([process.execPath, "src/server.ts"], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, MOTEL_OTEL_DB_PATH: root, MOTEL_RUNTIME_DIR: root, MOTEL_OTEL_HOST: "127.0.0.1", MOTEL_OTEL_PORT: String(port), MOTEL_OTEL_BASE_URL: `http://127.0.0.1:${port}`, MOTEL_OTEL_ENABLED: "false" },
		stdout: "ignore", stderr: "ignore",
	})
	try {
		let state: string | undefined
		const until = Date.now() + 10000
		while (Date.now() < until) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, { signal: AbortSignal.timeout(500) })
				state = (await response.json() as IngestReadiness).state
				if (state === "failed") {
					expect(response.status).toBe(503)
					break
				}
			} catch { /* Wait for the HTTP listener independently of writer bootstrap. */ }
			await sleep(25)
		}
		expect(state).toBe("failed")
		expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
	} finally {
		child.kill("SIGTERM")
		await Promise.race([child.exited, sleep(1000)])
		if (child.exitCode === null) child.kill("SIGKILL")
		await child.exited
		rmSync(root, { recursive: true, force: true })
	}
}, 15000)


test("completed maintenance cannot hide another operation that is still running", () => {
	const progress = new IngestProgress()
	progress.receive({ _tag: "maintenance", value: { operation: "retention", startedAt: 10, durationMs: null, outcome: "running" } })
	progress.receive({ _tag: "maintenance", value: { operation: "reclaim", startedAt: 20, durationMs: null, outcome: "running" } })
	progress.receive({ _tag: "maintenance", value: { operation: "reclaim", startedAt: 20, durationMs: 5, outcome: "completed" } })
	expect(progress.snapshot().maintenance).toMatchObject({ operation: "retention", outcome: "running" })
	progress.receive({ _tag: "maintenance", value: { operation: "retention", startedAt: 10, durationMs: 30, outcome: "completed" } })
	expect(progress.snapshot().maintenance).toMatchObject({ operation: "retention", outcome: "completed", durationMs: 30 })
})

test("simultaneous cold starts from different workdirs converge on one managed daemon", async () => {
	const root = mkdtempSync(join(tmpdir(), "motel-concurrent-start-"))
	const workdirs = [join(root, "a"), join(root, "b")]
	for (const workdir of workdirs) mkdirSync(workdir)
	const port = 36000 + Math.floor(Math.random() * 1000)
	const managers = workdirs.map((workdir) => createDaemonManager({ runtimeDir: root, databasePath: join(root, "db.sqlite"), port, workdir, startTimeoutMs: 5000, gracefulStopTimeoutMs: 500, forceStopTimeoutMs: 500 }))
	try {
		const states = await Promise.all(managers.map((manager) => Effect.runPromise(manager.ensure)))
		expect(states.every((state) => state.running && state.managed)).toBe(true)
		expect(states[0]!.pid).toBe(states[1]!.pid)
	} finally {
		await Effect.runPromise(managers[0]!.stop)
		rmSync(root, { recursive: true, force: true })
	}
}, 30000)

test("ensure preserves a live daemon when its ingest readiness budget expires", async () => {
	const root = mkdtempSync(join(tmpdir(), "motel-busy-ensure-"))
	const databasePath = join(root, "db.sqlite")
	const port = 37000 + Math.floor(Math.random() * 1000)
	const manager = createDaemonManager({ runtimeDir: root, databasePath, port })
	const impatient = createDaemonManager({ runtimeDir: root, databasePath, port, startTimeoutMs: 150 })
	let lock: Database | undefined
	try {
		const started = await Effect.runPromise(manager.ensure)
		lock = new Database(databasePath)
		lock.exec("BEGIN IMMEDIATE")
		const write = fetch(`http://127.0.0.1:${port}/v1/logs`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "blocked writer" } }] }] }] }),
		})
		await sleep(30)
		await expect(Effect.runPromise(impatient.ensure)).rejects.toThrow("process was preserved")
		const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { pid: number }
		expect(started.pid).toBe(health.pid)
		lock.exec("ROLLBACK")
		expect((await write).status).toBe(200)
		expect((await Effect.runPromise(manager.ensure)).pid).toBe(started.pid)
	} finally {
		try { lock?.exec("ROLLBACK") } catch {}
		lock?.close()
		await Effect.runPromise(manager.stop)
		rmSync(root, { recursive: true, force: true })
	}
}, 15000)
