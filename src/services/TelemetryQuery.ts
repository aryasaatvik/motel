import { Effect, Layer } from "effect"
import { config } from "../config.js"
import { TelemetryStoreReadonly, type TelemetryStoreReader } from "./TelemetryStore.js"
import { QueryScheduler } from "./queryScheduler.js"
import { QueryError, QueryOverloaded, QueryDeadlineExceeded, QueryUnavailable } from "./queryRpc.js"

export const TelemetryQueryLive = Layer.effect(
	TelemetryStoreReadonly,
	Effect.gen(function*() {
		const scheduler = yield* Effect.acquireRelease(
			Effect.sync(() => new QueryScheduler({
				workerUrl: new URL("./telemetryQueryProcess.ts", import.meta.url),
				capacity: config.otel.queryCapacity,
			environment: { ...process.env, MOTEL_OTEL_DB_PATH: config.otel.databasePath },
				deadlineMs: config.otel.queryDeadlineMs,
			})),
			(scheduler) => Effect.promise(() => scheduler.close()),
		)
		const run = <A>(method: keyof TelemetryStoreReader, args: readonly unknown[] = []) => Effect.tryPromise({
			try: (signal) => scheduler.query(method, args, signal) as Promise<A>,
			catch: (error) => error instanceof QueryError || error instanceof QueryOverloaded || error instanceof QueryDeadlineExceeded || error instanceof QueryUnavailable
				? error : new QueryUnavailable({ message: String(error) }),
		})
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
