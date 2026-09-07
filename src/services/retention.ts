import type { Database } from "bun:sqlite"

/** Additive schema: unfinished eviction is hidden from every public query. */
export const installRetentionSchema = (db: Database) => {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_retention_active_spans ON spans(trace_id) WHERE end_time_ms <= 0 OR end_time_ms < start_time_ms;
		CREATE INDEX IF NOT EXISTS idx_retention_ended ON trace_summaries(ended_at_ms, trace_id) WHERE active_span_count = 0 AND ended_at_ms > 0;
		CREATE INDEX IF NOT EXISTS idx_retention_started ON trace_summaries(started_at_ms, trace_id) WHERE active_span_count = 0;
		CREATE INDEX IF NOT EXISTS idx_logs_severity_nocase_cursor ON logs(severity_text COLLATE NOCASE, timestamp_ms DESC, id DESC);
		CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp_ms, id);
		CREATE TABLE IF NOT EXISTS retention_traces (trace_id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS retention_logs (id INTEGER PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS span_search_rows (id INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS idx_span_search_identity ON span_search_rows(trace_id, span_id);
		CREATE TABLE IF NOT EXISTS log_search_rows (id INTEGER PRIMARY KEY, log_id INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS idx_log_search_identity ON log_search_rows(log_id);
		CREATE VIEW IF NOT EXISTS retained_spans AS SELECT spans.rowid AS rowid, spans.* FROM spans
			WHERE NOT EXISTS (SELECT 1 FROM retention_traces d WHERE d.trace_id = spans.trace_id);
		CREATE VIEW IF NOT EXISTS retained_trace_summaries AS SELECT * FROM trace_summaries
			WHERE NOT EXISTS (SELECT 1 FROM retention_traces d WHERE d.trace_id = trace_summaries.trace_id);
		CREATE VIEW IF NOT EXISTS retained_logs AS SELECT * FROM logs
			WHERE NOT EXISTS (SELECT 1 FROM retention_traces d WHERE d.trace_id = logs.trace_id)
			AND NOT EXISTS (SELECT 1 FROM retention_logs d WHERE d.id = logs.id);
	`)
}

export type Checkpoint = { busy: number; log: number; checkpointed: number; deferred: boolean }

/** PASSIVE never waits for a reader to release its WAL snapshot. */
export const checkpointPassive = (db: Database): Checkpoint => {
	const result = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number }
	return { ...result, deferred: result.busy !== 0 || result.checkpointed < result.log }
}

/** FTS table presence is checked explicitly; genuine SQLite errors propagate. */
export const mergeFts = (db: Database, pages: number) => {
	for (const name of ["span_attr_fts", "log_body_fts", "span_operation_fts"]) {
		if (db.query("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name)) {
			db.query(`INSERT INTO ${name}(${name}, rank) VALUES ('merge', ?)`).run(pages)
		}
	}
}

type RetentionOptions = { cutoff: number; maxBytes: number; traces: number; logs: number; rows: number }

/**
 * Marks whole traces/logs atomically, then drains bounded dependent-row batches.
 * Row budgets bound cardinality, not bytes inside a single telemetry field. Markers survive
 * crashes; writers discard arrivals for marked traces until their eviction finishes.
 */
export const retainBatch = (db: Database, options: RetentionOptions) => db.transaction(() => {
	const pageCount = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
	const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
	const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size
	const oversized = (pageCount - free) * pageSize > options.maxBytes
	const pending = (db.query("SELECT count(*) AS n FROM retention_traces").get() as { n: number }).n
	const slots = Math.max(0, options.traces - pending)
	// Upgrade-era summaries may undercount active spans. The partial index verifies
	// actual span state before either age- or size-based eviction can select a trace.
	if (slots > 0) {
		db.query(`INSERT OR IGNORE INTO retention_traces SELECT trace_id FROM trace_summaries
			WHERE active_span_count = 0 AND ended_at_ms > 0 AND ended_at_ms < ?
			AND NOT EXISTS (SELECT 1 FROM retention_traces d WHERE d.trace_id = trace_summaries.trace_id)
			AND NOT EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = trace_summaries.trace_id AND (s.end_time_ms <= 0 OR s.end_time_ms < s.start_time_ms))
			ORDER BY ended_at_ms, trace_id LIMIT ?`).run(options.cutoff, slots)
		if (oversized) {
			const remaining = Math.max(0, options.traces - (db.query("SELECT count(*) AS n FROM retention_traces").get() as { n: number }).n)
			db.query(`INSERT OR IGNORE INTO retention_traces SELECT trace_id FROM trace_summaries
				WHERE active_span_count = 0 AND NOT EXISTS (SELECT 1 FROM retention_traces d WHERE d.trace_id = trace_summaries.trace_id)
				AND NOT EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = trace_summaries.trace_id AND (s.end_time_ms <= 0 OR s.end_time_ms < s.start_time_ms))
				ORDER BY started_at_ms, trace_id LIMIT ?`).run(remaining)
		}
	}
	const traceIds = db.query("SELECT trace_id FROM retention_traces ORDER BY trace_id LIMIT ?").all(options.traces) as { trace_id: string }[]
	// Correlated logs share trace visibility, including logs that have not yet been selected.
	for (const { trace_id } of traceIds) {
		const available = Math.max(0, options.logs - (db.query("SELECT count(*) AS n FROM retention_logs").get() as { n: number }).n)
		if (available === 0) break
		db.query(`INSERT OR IGNORE INTO retention_logs SELECT id FROM logs WHERE trace_id = ?
			AND NOT EXISTS (SELECT 1 FROM retention_logs d WHERE d.id = logs.id) LIMIT ?`).run(trace_id, available)
	}
	const available = Math.max(0, options.logs - (db.query("SELECT count(*) AS n FROM retention_logs").get() as { n: number }).n)
	db.query(`INSERT OR IGNORE INTO retention_logs SELECT id FROM logs WHERE timestamp_ms < ?
		AND NOT EXISTS (SELECT 1 FROM retention_logs d WHERE d.id = logs.id)
		ORDER BY timestamp_ms, id LIMIT ?`).run(oversized ? Number.MAX_SAFE_INTEGER : options.cutoff, available)

	let remaining = options.rows
	const remove = (sql: string, ...params: (string | number)[]) => {
		if (remaining <= 0) return
		const result = db.query(sql).run(...params, remaining)
		remaining -= Number(result.changes)
	}
	// Split the row budget between traces and logs so neither stream starves the other.
	remaining = Math.ceil(options.rows / 2)
	for (const { trace_id } of traceIds) {
		if (remaining <= 0) break
		remove("DELETE FROM span_attributes WHERE rowid IN (SELECT rowid FROM span_attributes WHERE trace_id = ? LIMIT ?)", trace_id)
		if (db.query("SELECT 1 FROM span_attributes WHERE trace_id = ? LIMIT 1").get(trace_id)) continue
		const searches = db.query("SELECT id FROM span_search_rows WHERE trace_id = ? LIMIT ?").all(trace_id, remaining) as { id: number }[]
		for (const { id } of searches) {
			db.query("DELETE FROM span_operation_fts WHERE rowid = ?").run(id)
			db.query("DELETE FROM span_search_rows WHERE id = ?").run(id)
			remaining--
		}
		if (db.query("SELECT 1 FROM span_search_rows WHERE trace_id = ? LIMIT 1").get(trace_id)) continue
		remove("DELETE FROM spans WHERE rowid IN (SELECT rowid FROM spans WHERE trace_id = ? LIMIT ?)", trace_id)
		if (!db.query("SELECT 1 FROM spans WHERE trace_id = ? LIMIT 1").get(trace_id)
			&& !db.query("SELECT 1 FROM logs WHERE trace_id = ? LIMIT 1").get(trace_id)) {
			db.query("DELETE FROM trace_summaries WHERE trace_id = ?").run(trace_id)
			db.query("DELETE FROM retention_traces WHERE trace_id = ?").run(trace_id)
		}
	}
	const traceRows = Math.ceil(options.rows / 2) - remaining
	remaining = options.rows - traceRows
	const logIds = db.query("SELECT id FROM retention_logs ORDER BY id LIMIT ?").all(options.logs) as { id: number }[]
	for (const { id } of logIds) {
		if (remaining <= 0) break
		remove("DELETE FROM log_attributes WHERE rowid IN (SELECT rowid FROM log_attributes WHERE log_id = ? LIMIT ?)", id)
		if (db.query("SELECT 1 FROM log_attributes WHERE log_id = ? LIMIT 1").get(id)) continue
		const searches = db.query("SELECT id FROM log_search_rows WHERE log_id = ? LIMIT ?").all(id, remaining) as { id: number }[]
		for (const search of searches) {
			db.query("DELETE FROM log_body_fts WHERE rowid = ?").run(search.id)
			db.query("DELETE FROM log_search_rows WHERE id = ?").run(search.id)
			remaining--
		}
		if (remaining <= 0 || db.query("SELECT 1 FROM log_search_rows WHERE log_id = ? LIMIT 1").get(id)) continue
		db.query("DELETE FROM logs WHERE id = ?").run(id)
		db.query("DELETE FROM retention_logs WHERE id = ?").run(id)
		remaining--
	}
	return { pending: oversized || traceIds.length > 0 || logIds.length > 0, rows: options.rows - remaining, markedTraces: traceIds.length, markedLogs: logIds.length }
})()

/** One-time bounded legacy repair. Current ingestion and deletion maintain mappings atomically. */
export const repairSearchRows = (db: Database, limit: number) => db.transaction(() => {
	for (const table of ["log_attributes", "log_body_fts", "span_operation_fts"] as const) {
		if (!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)) continue
		const key = `retention_repair_${table}`
		const marker = (db.query("SELECT value FROM motel_maintenance WHERE key = ?").get(key) as { value: string } | null)?.value
		if (marker === "complete") continue
		const cursor = Number(marker ?? 0)
		const columns = table === "span_operation_fts" ? "trace_id, span_id" : "log_id"
		const rows = db.query(`SELECT rowid AS repair_id, ${columns} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(cursor, limit) as { repair_id: number; log_id?: number | string; trace_id?: string; span_id?: string }[]
		for (const row of rows) {
			const exists = table === "span_operation_fts"
				? db.query("SELECT 1 FROM spans WHERE trace_id = ? AND span_id = ?").get(row.trace_id!, row.span_id!)
				: db.query("SELECT 1 FROM logs WHERE id = ?").get(Number(row.log_id))
			if (!exists) {
				db.query(`DELETE FROM ${table} WHERE rowid = ?`).run(row.repair_id)
				if (table !== "log_attributes") db.query(`DELETE FROM ${table === "log_body_fts" ? "log_search_rows" : "span_search_rows"} WHERE id = ?`).run(row.repair_id)
			} else if (table === "span_operation_fts") {
				db.query("INSERT OR REPLACE INTO span_search_rows VALUES (?, ?, ?)").run(row.repair_id, row.trace_id!, row.span_id!)
			} else if (table === "log_body_fts") {
				db.query("INSERT OR REPLACE INTO log_search_rows VALUES (?, ?)").run(row.repair_id, Number(row.log_id))
			}
		}
		db.query("INSERT OR REPLACE INTO motel_maintenance VALUES (?, ?)").run(key, rows.length < limit ? "complete" : String(rows.at(-1)!.repair_id))
	}
})()
