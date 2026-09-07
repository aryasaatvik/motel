import { Context, Schema } from "effect"

const Checkpoint = Schema.Struct({
	busy: Schema.Number, log: Schema.Number, checkpointed: Schema.Number, deferred: Schema.Boolean,
})

const Maintenance = Schema.Struct({
	operation: Schema.String,
	startedAt: Schema.Number,
	durationMs: Schema.NullOr(Schema.Number),
	outcome: Schema.Literals(["running", "completed", "failed"]),
})

/** Cached writer diagnostics; reading this snapshot never dispatches SQLite work. */
export const IngestReadiness = Schema.Struct({
	state: Schema.Literals(["starting", "ready", "overloaded", "failed"]),
	outstandingRequests: Schema.Number,
	outstandingBytes: Schema.Number,
	oldestRequestAgeMs: Schema.Number,
	lastCommitAt: Schema.NullOr(Schema.Number),
	committedRecords: Schema.Number,
	maintenance: Schema.NullOr(Maintenance),
	checkpoint: Schema.NullOr(Checkpoint),
})
export type IngestReadiness = typeof IngestReadiness.Type

export const WriterEvent = Schema.TaggedUnion({
	ready: {},
	checkpoint: { value: Checkpoint },
	commit: { records: Schema.Number, at: Schema.Number },
	maintenance: { value: Maintenance },
})
export type WriterEvent = typeof WriterEvent.Type

/** Worker-local publisher defaults to no-op for standalone store consumers. */
export const WriterDiagnostics = Context.Reference<(event: WriterEvent) => void>("motel/WriterDiagnostics", {
	defaultValue: (): ((event: WriterEvent) => void) => () => {},
})

/** Tracks awaiting callers, not durable queued work. Cancellation does not undo a commit. */
export class IngestProgress {
	private ready = false
	private failed = false
	private readonly requests = new Map<symbol, { at: number; bytes: number }>()
	private lastCommitAt: number | null = null
	private committedRecords = 0
	private checkpoint: IngestReadiness["checkpoint"] = null
	private maintenance: IngestReadiness["maintenance"] = null
	private readonly activeMaintenance = new Map<string, NonNullable<IngestReadiness["maintenance"]>>()

	begin(bytes: number, now = Date.now()) {
		const id = Symbol()
		this.requests.set(id, { at: now, bytes })
		return () => { this.requests.delete(id) }
	}

	fail() { this.failed = true }

	receive(event: WriterEvent) {
		switch (event._tag) {
			case "checkpoint": this.checkpoint = event.value; break
			case "ready": this.ready = true; break
			case "commit":
				if (event.records > 0) {
					this.lastCommitAt = event.at
					this.committedRecords += event.records
				}
				break
			case "maintenance": {
				const value = event.value
				if (value.outcome === "running") this.activeMaintenance.set(value.operation, value)
				else {
					if (this.activeMaintenance.get(value.operation)?.startedAt === value.startedAt) this.activeMaintenance.delete(value.operation)
					this.maintenance = value
				}
				break
			}
		}
	}

	snapshot(now = Date.now()): IngestReadiness {
		let oldestRequestAgeMs = 0
		let outstandingBytes = 0
		for (const request of this.requests.values()) {
			oldestRequestAgeMs = Math.max(oldestRequestAgeMs, now - request.at)
			outstandingBytes += request.bytes
		}
		return {
			state: this.failed ? "failed" : !this.ready ? "starting" :
				oldestRequestAgeMs >= 5000 || this.requests.size >= 64 ? "overloaded" : "ready",
			outstandingRequests: this.requests.size,
			outstandingBytes,
			oldestRequestAgeMs,
			lastCommitAt: this.lastCommitAt,
			committedRecords: this.committedRecords,
			maintenance: [...this.activeMaintenance.values()].sort((a, b) => a.startedAt - b.startedAt)[0] ?? this.maintenance,
			checkpoint: this.checkpoint,
		}
	}
}
