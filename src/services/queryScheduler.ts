import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { QueryDeadlineExceeded, QueryError, QueryOverloaded, QueryReply, QueryUnavailable, type QueryRequest } from "./queryRpc.js"

type Pending = {
	readonly request: QueryRequest
	readonly resolve: (value: unknown) => void
	readonly reject: (error: Error) => void
	readonly signal: AbortSignal
	timer?: ReturnType<typeof setTimeout>
	onAbort?: () => void
	cancelled?: Error
	generation?: QueryProcess
}

/** One readonly process. SIGKILL is required to interrupt synchronous SQLite native code. */
class QueryProcess {
	readonly child: ReturnType<typeof Bun.spawn>
	readonly ready: Promise<void>
	closed = false
	private stopping?: Promise<void>
	private call?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }

	constructor(workerUrl: URL, environment: NodeJS.ProcessEnv) {
		const ready = Promise.withResolvers<void>()
		this.ready = ready.promise
		// A process may exit between requests; keep its bootstrap rejection observed.
		void this.ready.catch(() => {})
		this.child = Bun.spawn([process.execPath, fileURLToPath(workerUrl)], {
			stdin: "ignore", stdout: "ignore", stderr: "inherit",
			env: environment,
			serialization: "advanced",
			ipc: (data: unknown) => {
				let reply: QueryReply
				try { reply = Schema.decodeUnknownSync(QueryReply)(data) }
				catch {
					ready.reject(new QueryUnavailable({ message: "Invalid reply from query process" }))
					void this.stop()
					return
				}
				if (this.closed) return
				if (reply._tag === "ready") { ready.resolve(); return }
				if (this.call?.id !== reply.id) return
				const call = this.call
				this.call = undefined
				if (reply._tag === "result") call.resolve(reply.value)
				else call.reject(new QueryError({ message: reply.message }))
			},
			onExit: () => {
				this.closed = true
				const error = new QueryUnavailable({ message: "Readonly query process exited" })
				ready.reject(error)
				this.call?.reject(error)
				this.call = undefined
			},
		})
	}

	request(request: QueryRequest) {
		return new Promise<unknown>((resolve, reject) => {
			if (this.closed) { reject(new QueryUnavailable({ message: "Readonly query process is closed" })); return }
			this.call = { id: request.id, resolve, reject }
			try { this.child.send(request) }
			catch (error) { this.call = undefined; reject(new QueryUnavailable({ message: String(error) })) }
		})
	}

	stop(): Promise<void> {
		return this.stopping ??= (async () => {
			this.closed = true
			this.child.kill("SIGKILL")
			await this.child.exited
		})()
	}
}

/** FIFO admission includes startup and queue time in each request's deadline. */
export class QueryScheduler {
	private readonly queued: Pending[] = []
	private readonly outstanding = new Set<Pending>()
	private active?: Pending
	private generation?: QueryProcess
	private nextId = 0
	private closed = false

	constructor(private readonly options: { workerUrl: URL; capacity: number; deadlineMs: number; environment?: NodeJS.ProcessEnv }) {}

	query(method: string, args: readonly unknown[], signal: AbortSignal): Promise<unknown> {
		if (this.closed) return Promise.reject(new QueryUnavailable({ message: "Query scheduler is closed" }))
		if (signal.aborted) return Promise.reject(new QueryUnavailable({ message: "Query cancelled before admission" }))
		if (this.outstanding.size >= this.options.capacity) return Promise.reject(new QueryOverloaded({ message: "Readonly query capacity is exhausted; retry later" }))
		return new Promise((resolve, reject) => {
			const entry: Pending = { request: { id: ++this.nextId, method, args }, resolve, reject, signal }
			entry.onAbort = () => this.cancel(entry, new QueryUnavailable({ message: "Query cancelled by caller" }))
			entry.timer = setTimeout(() => this.cancel(entry, new QueryDeadlineExceeded({ message: `Query exceeded its ${this.options.deadlineMs} ms budget` })), this.options.deadlineMs)
			signal.addEventListener("abort", entry.onAbort, { once: true })
			this.outstanding.add(entry)
			this.queued.push(entry)
			this.pump()
		})
	}

	private finish(entry: Pending) {
		clearTimeout(entry.timer)
		if (entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort)
		this.outstanding.delete(entry)
	}

	private cancel(entry: Pending, error: Error) {
		if (!this.outstanding.has(entry) || entry.cancelled) return
		entry.cancelled = error
		if (this.active === entry) {
			// Do not release admission or report a deadline until the OS has closed the
			// process, including its SQLite connection and any retained WAL snapshot.
			void entry.generation?.stop()
		} else {
			const index = this.queued.indexOf(entry)
			if (index !== -1) this.queued.splice(index, 1)
			this.finish(entry)
			entry.reject(error)
		}
	}

	private pump() {
		if (this.active || this.closed) return
		const entry = this.queued.shift()
		if (!entry) return
		this.active = entry
		void this.execute(entry)
	}

	private async execute(entry: Pending) {
		try {
			const generation = this.generation && !this.generation.closed ? this.generation : new QueryProcess(this.options.workerUrl, this.options.environment ?? { ...process.env })
			this.generation = generation
			entry.generation = generation
			await generation.ready
			if (entry.cancelled) throw entry.cancelled
			const value = await generation.request(entry.request)
			if (entry.cancelled) throw entry.cancelled
			entry.resolve(value)
		} catch (error) {
			if (entry.cancelled) await entry.generation?.stop()
			entry.reject(entry.cancelled ?? (error instanceof Error ? error : new QueryUnavailable({ message: String(error) })))
		} finally {
			this.finish(entry)
			this.active = undefined
			this.pump()
		}
	}

	async close() {
		this.closed = true
		for (const entry of [...this.outstanding]) this.cancel(entry, new QueryUnavailable({ message: "Query scheduler is closing" }))
		await this.generation?.stop()
	}
}
