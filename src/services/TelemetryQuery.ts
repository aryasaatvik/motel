import * as BunWorker from "@effect/platform-bun/BunWorker"
import { Effect, Layer, Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type { WorkerError } from "effect/unstable/workers/WorkerError"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { TelemetryStoreReadonly, type TelemetryStoreReader } from "./TelemetryStore.js"
import { QueryRpcs } from "./queryRpc.js"

type QueryMethod = keyof TelemetryStoreReader
type QueryClient = RpcClient.FromGroup<typeof QueryRpcs, RpcClientError | WorkerError>

const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(BunWorker.layer(() => new Worker(new URL("./telemetryQueryWorker.ts", import.meta.url)))),
)

const query = <A>(getClient: Effect.Effect<QueryClient, unknown>, method: QueryMethod, args: readonly unknown[] = []) =>
	Effect.flatMap(getClient, (client) => client.query({ method, args })).pipe(
		Effect.map((result) => result as A),
		Effect.mapError((error) => error instanceof Error ? error : new Error(String(error))),
	)

export const TelemetryQueryLive = Layer.effect(
	TelemetryStoreReadonly,
	Effect.gen(function*() {
		const scope = yield* Scope.Scope
		const getClient = yield* Effect.cached(Effect.gen(function*() {
			const clientScope = yield* Scope.fork(scope, "sequential")
			const protocolContext = yield* Layer.buildWithScope(WorkerProtocol, clientScope)
			return yield* RpcClient.make(QueryRpcs).pipe(
				Effect.provide(protocolContext),
				Effect.provideService(Scope.Scope, clientScope),
			)
		}))
		const run = <A>(method: QueryMethod, args: readonly unknown[] = []) => query<A>(getClient, method, args)
		return TelemetryStoreReadonly.of({
			listServices: run("listServices"),
			listRecentTraces: (serviceName, options) => run("listRecentTraces", [serviceName, options]),
			listTraceSummaries: (serviceName, options) => run("listTraceSummaries", [serviceName, options]),
			searchTraces: (input) => run("searchTraces", [input]),
			searchTraceSummaries: (input) => run("searchTraceSummaries", [input]),
			traceStats: (input) => run("traceStats", [input]),
			getTrace: (traceId) => run("getTrace", [traceId]),
			getSpan: (spanId) => run("getSpan", [spanId]),
			listTraceSpans: (traceId) => run("listTraceSpans", [traceId]),
			searchSpans: (input) => run("searchSpans", [input]),
			searchLogs: (input) => run("searchLogs", [input]),
			logStats: (input) => run("logStats", [input]),
			listFacets: (input) => run("listFacets", [input]),
			listRecentLogs: (serviceName) => run("listRecentLogs", [serviceName]),
			listTraceLogs: (traceId) => run("listTraceLogs", [traceId]),
			searchAiCalls: (input) => run("searchAiCalls", [input]),
			getAiCall: (spanId) => run("getAiCall", [spanId]),
			aiCallStats: (input) => run("aiCallStats", [input]),
		})
	}),
)
