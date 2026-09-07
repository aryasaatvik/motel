/** Isolated contention benchmark. Never opens the machine-global telemetry database. */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createDaemonManager } from "../src/daemon.ts"

const representative = process.argv.includes("--1gib")
const capMb = representative ? 1024 : 16
const root = mkdtempSync(join(tmpdir(), "motel-contention-"))
const databasePath = join(root, "telemetry.sqlite")
const port = 33000 + Math.floor(Math.random() * 2000)
process.env.MOTEL_OTEL_MAX_DB_SIZE_MB = String(capMb)
process.env.MOTEL_OTEL_RETENTION_INTERVAL_SECONDS = "1"
process.env.MOTEL_OTEL_RETENTION_LOG_BATCH = "250"
const manager = createDaemonManager({ runtimeDir: root, databasePath, port })
const base = `http://127.0.0.1:${port}`
const samples: Record<string, number[]> = {}
let failures = 0
let records = 0
const request = async (name: string, path: string, body?: unknown) => {
	const started = performance.now()
	try {
		const response = await fetch(`${base}${path}`, {
			signal: AbortSignal.timeout(30000),
			...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		})
		await response.arrayBuffer()
		if (!response.ok) failures++
	} catch { failures++ }
	;(samples[name] ??= []).push(performance.now() - started)
}
const attributes = (run: number) => [
	{ key: "service.name", value: { stringValue: "contention" } },
	{ key: "samva.qa.run.id", value: { stringValue: `run-${run}` } },
]
const logs = (run: number) => ({ resourceLogs: [{ resource: { attributes: attributes(run) }, scopeLogs: [{ logRecords: Array.from({ length: 250 }, (_, index) => ({
	timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
	body: { stringValue: `${run}-${records++}-${index} ${"representative log payload ".repeat(160)}` },
})) }] }] })
const traces = (run: number) => ({ resourceSpans: [{ resource: { attributes: attributes(run) }, scopeSpans: [{ spans: Array.from({ length: 50 }, () => ({
	traceId: crypto.randomUUID().replaceAll("-", ""), spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16), name: "harvest.run", status: { code: 1 },
	startTimeUnixNano: String(BigInt(Date.now() - 100) * 1_000_000n), endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
})) }] }] })
const bytes = (file: string) => { try { return statSync(file).size } catch { return 0 } }
try {
	await Effect.runPromise(manager.ensure)
	// Seed beyond the configured live-page target while retention is active.
	const rounds = representative ? 1400 : 30
	for (let round = 0; round < rounds; round++) {
		await request("seed", "/v1/logs", logs(round % 4))
		if (round % 100 === 0) process.stderr.write(`seed ${round}/${rounds}\n`)
	}
	const db = new Database(databasePath, { readonly: true })
	const before = { database: bytes(databasePath), wal: bytes(`${databasePath}-wal`) }
	// Hold a WAL snapshot across subsequent writes, then run ingest and harvest together.
	db.exec("BEGIN")
	db.query("SELECT count(*) FROM logs").get()
	await request("logs", "/v1/logs", logs(0))
	const releaseReader = setTimeout(() => db.exec("ROLLBACK"), 5000)
	try {
		for (let round = 0; round < 30; round++) {
			const started = performance.now()
			await Promise.all([
				...Array.from({ length: 4 }, (_, run) => request("logs", "/v1/logs", logs(run))),
				request("traces", "/v1/traces", traces(0)),
				request("search", "/api/spans/search?service=contention&attr.samva.qa.run.id=run-0&limit=100"),
				request("harvest", "/api/logs/search?service=contention&attr.samva.qa.run.id=run-1&limit=100"),
				request("health", "/api/health"),
				request("readiness", "/api/readiness"),
			])
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, 250 - (performance.now() - started))))
		}
	} finally {
		clearTimeout(releaseReader)
		try { db.exec("ROLLBACK") } catch { /* The timed release already ended the snapshot. */ }
		db.close()
	}
	const inspect = new Database(databasePath, { readonly: true })
	const pages = inspect.query("PRAGMA page_count").get()
	const free = inspect.query("PRAGMA freelist_count").get()
	inspect.close()
	const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
		values.sort((a, b) => a - b)
		const quantile = (q: number) => Math.round(values[Math.min(values.length - 1, Math.floor(values.length * q))]! * 100) / 100
		return [name, { count: values.length, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: quantile(1) }]
	}))
	console.log(JSON.stringify({ profile: representative ? "1gib" : "reduced", capMb, failures, before, after: { database: bytes(databasePath), wal: bytes(`${databasePath}-wal`), pages, free }, milliseconds: summary }, null, 2))
} finally {
	await Effect.runPromise(manager.stop)
	rmSync(root, { recursive: true, force: true })
}
