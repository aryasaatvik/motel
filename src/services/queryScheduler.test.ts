import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { QueryScheduler } from "./queryScheduler.ts"
import { QueryDeadlineExceeded, QueryOverloaded, QueryUnavailable } from "./queryRpc.ts"
import { checkpointPassive } from "./retention.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const fixture = (capacity = 2, deadlineMs = 800) => {
	const root = mkdtempSync(join(tmpdir(), "motel-query-cancel-"))
	const path = join(root, "db.sqlite")
	const events = join(root, "events")
	writeFileSync(events, "")
	const db = new Database(path)
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1); PRAGMA wal_checkpoint(PASSIVE)")
	const worker = join(root, "readonly worker.ts")
	writeFileSync(worker, `
import { Database } from "bun:sqlite"
import { appendFileSync } from "node:fs"
const db = new Database(${JSON.stringify(path)}, { readonly: true })
process.on("message", request => {
 appendFileSync(${JSON.stringify(events)}, request.method + "\\n")
 if (request.method === "slow") {
  db.exec("BEGIN")
  db.query("SELECT * FROM t").all()
  appendFileSync(${JSON.stringify(events)}, "reader-held\\n")
  db.query("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n").get()
 }
 process.send({_tag:"result", id:request.id, value:db.query("SELECT count(*) AS n FROM t").get()})
})
process.send({_tag:"ready"})
`)
	const scheduler = new QueryScheduler({ workerUrl: pathToFileURL(worker), capacity, deadlineMs })
	const held = async () => {
		for (let i = 0; i < 100 && !readFileSync(events, "utf8").includes("reader-held"); i++) await sleep(5)
		expect(readFileSync(events, "utf8")).toContain("reader-held")
	}
	return { scheduler, db, held, events: () => readFileSync(events, "utf8"), close: async () => { await scheduler.close(); db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test("deadline stops executing SQLite, releases its reader, and allows the next useful query", async () => {
	const f = fixture()
	try {
		const slow = f.scheduler.query("slow", [], new AbortController().signal).catch((error) => error)
		await f.held()
		f.db.exec("INSERT INTO t VALUES(2)")
		expect(checkpointPassive(f.db).deferred).toBe(true)
		await sleep(200)
		const next = f.scheduler.query("short", [], new AbortController().signal)
		await expect(f.scheduler.query("overflow", [], new AbortController().signal)).rejects.toBeInstanceOf(QueryOverloaded)
		expect(await slow).toBeInstanceOf(QueryDeadlineExceeded)
		expect(checkpointPassive(f.db).deferred).toBe(false)
		expect(await next).toEqual({ n: 2 })
		expect(f.events()).not.toContain("overflow")
	} finally { await f.close() }
}, 5000)

test("cancelling queued work prevents dispatch without interrupting the current reader", async () => {
	const f = fixture()
	try {
		const active = new AbortController()
		const slow = f.scheduler.query("slow", [], active.signal).catch((error) => error)
		await f.held()
		const queued = new AbortController()
		const obsolete = f.scheduler.query("obsolete", [], queued.signal).catch((error) => error)
		queued.abort()
		expect(await obsolete).toBeInstanceOf(QueryUnavailable)
		f.db.exec("INSERT INTO t VALUES(2)")
		expect(checkpointPassive(f.db).deferred).toBe(true)
		active.abort()
		expect(await slow).toBeInstanceOf(QueryUnavailable)
		expect(checkpointPassive(f.db).deferred).toBe(false)
		expect(await f.scheduler.query("short", [], new AbortController().signal)).toEqual({ n: 2 })
		expect(f.events()).not.toContain("obsolete")
	} finally { await f.close() }
}, 5000)

test("expired queued requests are removed before a replacement process can dispatch them", async () => {
	const f = fixture(4, 400)
	try {
		const queries = ["slow", "expired-one", "expired-two", "expired-three"].map((method) => f.scheduler.query(method, [], new AbortController().signal).catch((error) => error))
		const results = await Promise.all(queries)
		for (const result of results) expect(result).toBeInstanceOf(QueryDeadlineExceeded)
		expect(f.events()).not.toContain("expired-")
		expect(await f.scheduler.query("short", [], new AbortController().signal)).toEqual({ n: 1 })
	} finally { await f.close() }
}, 5000)


test("query processes receive the explicit runtime environment", async () => {
	const root = mkdtempSync(join(tmpdir(), "motel-query-env-"))
	const worker = join(root, "environment.ts")
	writeFileSync(worker, `process.on("message", request => process.send({_tag:"result", id:request.id, value:process.env.MOTEL_OTEL_DB_PATH})); process.send({_tag:"ready"})`)
	const databasePath = join(root, "isolated.sqlite")
	const scheduler = new QueryScheduler({ workerUrl: pathToFileURL(worker), capacity: 1, deadlineMs: 2000, environment: { ...process.env, MOTEL_OTEL_DB_PATH: databasePath } })
	try {
		expect(await scheduler.query("path", [], new AbortController().signal)).toBe(databasePath)
	} finally { await scheduler.close(); rmSync(root, { recursive: true, force: true }) }
})
