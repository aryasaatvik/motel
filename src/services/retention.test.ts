import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointPassive, installRetentionSchema, mergeFts, repairSearchRows, retainBatch } from "./retention.ts"

const schema = (db: Database) => {
	db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;
		CREATE TABLE spans(trace_id TEXT, span_id TEXT, PRIMARY KEY(trace_id, span_id));
		CREATE TABLE span_attributes(trace_id TEXT, span_id TEXT, key TEXT, value TEXT);
		CREATE INDEX attrs_trace ON span_attributes(trace_id);
		CREATE TABLE trace_summaries(trace_id TEXT PRIMARY KEY, started_at_ms INTEGER, ended_at_ms INTEGER, active_span_count INTEGER);
		CREATE TABLE logs(id INTEGER PRIMARY KEY, trace_id TEXT, timestamp_ms INTEGER, severity_text TEXT);
		CREATE INDEX logs_trace ON logs(trace_id);
		CREATE TABLE log_attributes(log_id INTEGER, key TEXT, value TEXT);
		CREATE INDEX attrs_log ON log_attributes(log_id);
		CREATE TABLE motel_maintenance(key TEXT PRIMARY KEY, value TEXT);
		CREATE VIRTUAL TABLE span_operation_fts USING fts5(trace_id UNINDEXED, span_id UNINDEXED, operation_name);
		CREATE VIRTUAL TABLE log_body_fts USING fts5(log_id UNINDEXED, body);
	`)
	installRetentionSchema(db)
}
const options = { cutoff: 100, maxBytes: Number.MAX_SAFE_INTEGER, traces: 10, logs: 10, rows: 24 }
const count = (db: Database, table: string) => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test("huge traces disappear atomically, drain by rows, survive reopen, and preserve active traces", () => {
	const root = mkdtempSync(join(tmpdir(), "motel-retention-"))
	const path = join(root, "test.sqlite")
	let db = new Database(path)
	try {
		schema(db)
		db.exec("INSERT INTO trace_summaries VALUES ('large', 1, 2, 0), ('active', 1, 0, 1), ('boundary', 1, 100, 0)")
		db.transaction(() => {
			for (let index = 0; index < 200; index++) {
				db.query("INSERT INTO spans VALUES ('large', ?)").run(String(index))
				for (let attr = 0; attr < 4; attr++) db.query("INSERT INTO span_attributes VALUES ('large', ?, ?, 'value')").run(String(index), String(attr))
			}
			db.exec("INSERT INTO spans VALUES ('active','a'), ('boundary','b'); INSERT INTO logs VALUES (1, 'large', 1000, 'INFO'); INSERT INTO log_attributes VALUES (1,'key','value')")
		})()
		const result = retainBatch(db, options)
		expect(result.rows).toBeLessThanOrEqual(options.rows)
		expect(count(db, "spans")).toBe(202)
		expect(count(db, "retained_spans")).toBe(2)
		expect(count(db, "retained_trace_summaries")).toBe(2)
		expect(count(db, "retained_logs")).toBe(0)
		db.close()
		db = new Database(path)
		expect(count(db, "retention_traces")).toBe(1)
		let passes = 0
		while (count(db, "retention_traces") > 0 && passes++ < 200) {
			expect(retainBatch(db, options).rows).toBeLessThanOrEqual(options.rows)
			expect(count(db, "retained_spans")).toBe(2)
		}
		expect(passes).toBeLessThan(200)
		expect(count(db, "spans")).toBe(2)
		expect(count(db, "span_attributes")).toBe(0)
		expect(count(db, "logs")).toBe(0)
		expect(count(db, "log_attributes")).toBe(0)
	} finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test("failed cleanup rolls back its visibility marker and rows", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		db.exec(`INSERT INTO trace_summaries VALUES ('trace',1,2,0); INSERT INTO spans VALUES ('trace','span');
			INSERT INTO span_attributes VALUES ('trace','span','key','value');
			CREATE TRIGGER fail_delete BEFORE DELETE ON span_attributes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`)
		expect(() => retainBatch(db, options)).toThrow("injected failure")
		expect(count(db, "retention_traces")).toBe(0)
		expect(count(db, "retained_spans")).toBe(1)
		expect(count(db, "span_attributes")).toBe(1)
		db.exec("DROP TRIGGER fail_delete")
		retainBatch(db, options)
		expect(count(db, "retained_spans")).toBe(0)
	} finally { db.close() }
})

test("PASSIVE reports an incomplete checkpoint without waiting for a held reader", () => {
	const root = mkdtempSync(join(tmpdir(), "motel-checkpoint-"))
	const path = join(root, "test.sqlite")
	const writer = new Database(path)
	let reader: Database | undefined
	try {
		schema(writer)
		checkpointPassive(writer)
		reader = new Database(path, { readonly: true })
		reader.exec("BEGIN")
		reader.query("SELECT * FROM spans").all()
		writer.exec("INSERT INTO spans VALUES ('trace','span')")
		const start = performance.now()
		const result = checkpointPassive(writer)
		expect(performance.now() - start).toBeLessThan(500)
		expect(result.deferred).toBe(true)
		expect(result.log).toBeGreaterThan(result.checkpointed)
		reader.exec("ROLLBACK")
		expect(checkpointPassive(writer).deferred).toBe(false)
	} finally { reader?.close(); writer.close(); rmSync(root, { recursive: true, force: true }) }
})

test("explicit FTS merging consolidates segments and preserves search results", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		db.exec("INSERT INTO log_body_fts(log_body_fts, rank) VALUES ('automerge', 0); INSERT INTO log_body_fts(log_body_fts, rank) VALUES ('crisismerge', 1000)")
		for (let index = 0; index < 40; index++) db.query("INSERT INTO log_body_fts(log_id, body) VALUES (?, 'searchable token')").run(String(index))
		const before = count(db, "log_body_fts_idx")
		mergeFts(db, 100)
		expect(count(db, "log_body_fts_idx")).toBeLessThan(before)
		expect((db.query("SELECT count(*) AS n FROM log_body_fts WHERE log_body_fts MATCH 'searchable'").get() as { n: number }).n).toBe(40)
		db.exec("DROP TABLE log_body_fts; CREATE TABLE log_body_fts(broken TEXT)")
		expect(() => mergeFts(db, 100)).toThrow()
	} finally { db.close() }
})

test("legacy orphan repair advances a bounded cursor and maps live FTS rowids", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		for (let index = 1; index <= 20; index++) {
			db.query("INSERT INTO logs VALUES (?,NULL,1000,'INFO')").run(index)
			db.query("INSERT INTO log_attributes VALUES (?,'key','value')").run(index)
			db.query("INSERT INTO log_body_fts(log_id,body) VALUES (?,'searchable')").run(String(index))
		}
		db.exec("INSERT INTO log_attributes VALUES (999,'orphan','value'); INSERT INTO log_body_fts(log_id,body) VALUES ('999','orphan')")
		repairSearchRows(db, 5)
		expect(count(db, "log_search_rows")).toBe(5)
		expect(count(db, "log_attributes")).toBe(21)
		for (let pass = 0; pass < 5; pass++) repairSearchRows(db, 5)
		expect(count(db, "log_attributes")).toBe(20)
		expect(count(db, "log_body_fts")).toBe(20)
		expect(count(db, "log_search_rows")).toBe(20)
		const expired = retainBatch(db, { ...options, cutoff: 2000, logs: 1, rows: 100 })
		expect(expired.markedLogs).toBe(1)
		expect(count(db, "logs")).toBe(19)
		expect(count(db, "log_body_fts")).toBe(19)
	} finally { db.close() }
})

test("retention selectors use ordered partial indexes", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		const plan = db.query("EXPLAIN QUERY PLAN SELECT trace_id FROM trace_summaries WHERE active_span_count = 0 AND ended_at_ms > 0 AND ended_at_ms < ? ORDER BY ended_at_ms, trace_id LIMIT 100").all(100) as { detail: string }[]
		expect(plan.some(({ detail }) => detail.includes("idx_retention_ended"))).toBe(true)
		expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false)
	} finally { db.close() }
})
