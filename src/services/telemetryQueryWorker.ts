import { BunRuntime } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { TelemetryStoreQueryWorkerLive, TelemetryStoreReadonly, type TelemetryStoreReader } from "./TelemetryStore.js"
import { QueryRequest, type QueryReply } from "./queryRpc.js"

const send = (reply: QueryReply) => postMessage(reply)

// This thread owns only a readonly SQLite connection. Its enclosing process is
// retired on query deadlines; the ingestion worker is never part of that process.
Effect.scoped(Effect.gen(function*() {
	const store = yield* TelemetryStoreReadonly
	let busy = false
	const receive = ({ data }: MessageEvent<unknown>) => {
		const request = Schema.decodeUnknownSync(QueryRequest)(data)
		if (!Object.hasOwn(store, request.method) || busy) {
			send({ _tag: "error", id: request.id, message: "Invalid or concurrent query request" })
			return
		}
		busy = true
		const member = store[request.method as keyof TelemetryStoreReader]
		const result = typeof member === "function" ? Reflect.apply(member, store, request.args) : member
		void Effect.runPromise(result as Effect.Effect<unknown, Error>).then(
			(value) => { busy = false; send({ _tag: "result", id: request.id, value }) },
			(error) => { busy = false; send({ _tag: "error", id: request.id, message: String(error) }) },
		)
	}
	addEventListener("message", receive)
	yield* Effect.addFinalizer(() => Effect.sync(() => removeEventListener("message", receive)))
	send({ _tag: "ready" })
	return yield* Effect.never
})).pipe(Effect.provide(TelemetryStoreQueryWorkerLive), BunRuntime.runMain)
