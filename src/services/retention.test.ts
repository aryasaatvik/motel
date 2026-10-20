import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointPassive, installRetentionSchema, mergeFts, repairSearchRows, retainBatch, SPAN_SEARCH_MAPPING_READY_KEY } from "./retention.ts"

const schema = (db: Database) => {
	db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;
		CREATE TABLE spans(trace_id TEXT, span_id TEXT, start_time_ms INTEGER DEFAULT 1, end_time_ms INTEGER DEFAULT 2, PRIMARY KEY(trace_id, span_id));
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
				db.query("INSERT INTO spans(trace_id, span_id) VALUES ('large', ?)").run(String(index))
				for (let attr = 0; attr < 4; attr++) db.query("INSERT INTO span_attributes VALUES ('large', ?, ?, 'value')").run(String(index), String(attr))
			}
			db.exec("INSERT INTO spans(trace_id, span_id) VALUES ('active','a'), ('boundary','b'); INSERT INTO logs VALUES (1, 'large', 1000, 'INFO'); INSERT INTO log_attributes VALUES (1,'key','value')")
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
		db.exec(`INSERT INTO trace_summaries VALUES ('trace',1,2,0); INSERT INTO spans(trace_id, span_id) VALUES ('trace','span');
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
		writer.exec("INSERT INTO spans(trace_id, span_id) VALUES ('trace','span')")
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
		const before = db.query("SELECT total_changes() AS n").get() as { n: number }
		for (let pass = 0; pass < 5; pass++) repairSearchRows(db, 5)
		expect(db.query("SELECT total_changes() AS n").get()).toEqual(before)
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


test("stale upgraded summaries cannot evict active spans under age or size retention", () => {
	for (const maxBytes of [Number.MAX_SAFE_INTEGER, 0]) {
		const db = new Database(":memory:")
		try {
			schema(db)
			db.exec("INSERT INTO trace_summaries VALUES ('stale', 1, 2, 0)")
			db.exec("INSERT INTO spans(trace_id,span_id,start_time_ms,end_time_ms) VALUES ('stale','running',1,0)")
			retainBatch(db, { ...options, maxBytes })
			expect(count(db, "retained_spans")).toBe(1)
			expect(count(db, "retention_traces")).toBe(0)
			db.exec("UPDATE spans SET end_time_ms = 2")
			retainBatch(db, { ...options, maxBytes })
			expect(count(db, "retained_spans")).toBe(0)
		} finally { db.close() }
	}
})


test("operation mapping readiness waits for complete legacy repair and stays idle after reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "motel-mapping-ready-"))
	const path = join(root, "test.sqlite")
	let db = new Database(path)
	try {
		schema(db)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "complete" })
		db.query("DELETE FROM motel_maintenance WHERE key = ?").run(SPAN_SEARCH_MAPPING_READY_KEY)
		db.exec("INSERT INTO spans(trace_id,span_id) VALUES ('a','s'), ('b','s'); INSERT INTO span_operation_fts(trace_id,span_id,operation_name) VALUES ('a','s','alpha'), ('b','s','beta'), ('orphan','s','orphan')")
		// All three unmapped historical rows are below the pre-upgrade durable cursor.
		db.exec("INSERT OR REPLACE INTO motel_maintenance VALUES ('retention_repair_span_operation_fts', '999')")
		db.exec("CREATE TRIGGER refuse_mapping_marker BEFORE INSERT ON motel_maintenance WHEN NEW.key = 'span_search_mapping_complete' BEGIN SELECT RAISE(ABORT, 'marker failure'); END")
		expect(() => installRetentionSchema(db)).toThrow("marker failure")
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = 'retention_repair_span_operation_fts'").get()).toEqual({ value: "999" })
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toBeNull()
		db.exec("DROP TRIGGER refuse_mapping_marker")
		installRetentionSchema(db)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = 'retention_repair_span_operation_fts'").get()).toBeNull()
		expect(repairSearchRows(db, 1)).toBe(true)
		expect(count(db, "span_search_rows")).toBe(1)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "repairing" })
		db.close()
		db = new Database(path)
		installRetentionSchema(db)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = 'retention_repair_span_operation_fts'").get()).toEqual({ value: "1" })
		expect(repairSearchRows(db, 1)).toBe(true)
		expect(count(db, "span_search_rows")).toBe(2)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "repairing" })
		expect(repairSearchRows(db, 1)).toBe(true)
		expect(count(db, "span_operation_fts")).toBe(2)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "repairing" })
		expect(repairSearchRows(db, 1)).toBe(false)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "complete" })
		db.close()
		db = new Database(path)
		installRetentionSchema(db)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = 'retention_repair_span_operation_fts'").get()).toEqual({ value: "3" })
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "complete" })
		const before = db.query("SELECT total_changes() AS n").get()
		expect(repairSearchRows(db, 1)).toBe(false)
		expect(db.query("SELECT total_changes() AS n").get()).toEqual(before)
	} finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})


test("a final partial span repair returns idle despite remaining log repair", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		db.query("DELETE FROM motel_maintenance WHERE key = ?").run(SPAN_SEARCH_MAPPING_READY_KEY)
		db.exec("INSERT INTO spans(trace_id, span_id) VALUES ('a', 's'), ('b', 's'); INSERT INTO span_operation_fts(trace_id, span_id, operation_name) VALUES ('a', 's', 'alpha'), ('b', 's', 'beta')")
		for (let id = 1; id <= 7; id++) {
			db.query("INSERT INTO logs VALUES (?, NULL, 1000, 'INFO')").run(id)
			db.query("INSERT INTO log_attributes VALUES (?, 'key', 'value')").run(id)
			db.query("INSERT INTO log_body_fts(log_id, body) VALUES (?, 'searchable')").run(String(id))
		}
		installRetentionSchema(db)
		expect(repairSearchRows(db, 3)).toBe(false)
		expect(count(db, "span_search_rows")).toBe(2)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "complete" })
		expect(count(db, "log_body_fts")).toBe(7)
		expect(count(db, "log_search_rows")).toBe(3)
	} finally { db.close() }
})

test("an unavailable optional span index does not request fast repair retries", () => {
	const db = new Database(":memory:")
	try {
		schema(db)
		db.query("UPDATE motel_maintenance SET value = 'repairing' WHERE key = ?").run(SPAN_SEARCH_MAPPING_READY_KEY)
		db.exec("DROP TABLE span_operation_fts")
		expect(repairSearchRows(db, 3)).toBe(false)
		expect(db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(SPAN_SEARCH_MAPPING_READY_KEY)).toEqual({ value: "repairing" })
	} finally { db.close() }
})
