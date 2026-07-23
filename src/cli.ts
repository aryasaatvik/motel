import { Console, Effect, Option, References } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { config } from "./config.js"
import { otelServerInstructions } from "./instructions.js"
import { attributeFiltersFromArgs, isAttributeFilterToken } from "./queryFilters.js"
import { queryRuntime } from "./runtime.js"
import { TelemetryStoreReadonly } from "./services/TelemetryStore.js"

const json = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const query = <A>(effect: Effect.Effect<A, unknown, TelemetryStoreReadonly>) =>
	Effect.promise(() => queryRuntime.runPromise(effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")))).pipe(
		Effect.andThen(json),
		Effect.ensuring(Effect.promise(() => queryRuntime.dispose())),
	)

const optional = (value: Option.Option<string>, fallback?: string) => Option.getOrElse(value, () => fallback)

const services = Command.make("services", {}, () =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.listServices)),
).pipe(Command.withDescription("List observed telemetry services"))

const traces = Command.make("traces", {
	service: Argument.string("service").pipe(Argument.optional),
	limit: Argument.integer("limit").pipe(Argument.optional),
}, ({ service, limit }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) =>
		store.listRecentTraces(optional(service, config.otel.serviceName)!, {
			limit: Option.getOrElse(limit, () => config.otel.traceFetchLimit),
		}),
	)),
).pipe(Command.withDescription("List recent traces"))

const trace = Command.make("trace", {
	traceId: Argument.string("trace-id"),
}, ({ traceId }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.getTrace(traceId))),
).pipe(Command.withDescription("Get one trace"))

const span = Command.make("span", {
	spanId: Argument.string("span-id"),
}, ({ spanId }) =>
	Effect.promise(() => fetch(`${config.otel.queryUrl}/api/spans/${encodeURIComponent(spanId)}`).then((response) => response.json())).pipe(
		Effect.andThen(json),
	),
).pipe(Command.withDescription("Get one span"))

const traceSpans = Command.make("trace-spans", {
	traceId: Argument.string("trace-id"),
}, ({ traceId }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.listTraceSpans(traceId))),
).pipe(Command.withDescription("List spans in one trace"))

const parseSearchSpans = (args: ReadonlyArray<string>) => {
	const service = args[0] ?? config.otel.serviceName
	const operation = args[1] && !isAttributeFilterToken(args[1]) && !args[1].startsWith("parent=") ? args[1] : undefined
	const parentTokenIndex = args.findIndex((value, index) => index > 0 && value.startsWith("parent="))
	const parentOperation = parentTokenIndex >= 0 ? args[parentTokenIndex]?.slice("parent=".length) : undefined
	const attributeStartIndex = operation ? 2 : 1
	return { service, operation, parentOperation, attributeFilters: attributeFiltersFromArgs(args.slice(attributeStartIndex)) }
}

const searchSpans = Command.make("search-spans", {
	args: Argument.string("service-or-filter").pipe(Argument.variadic),
}, ({ args }) => {
	const input = parseSearchSpans(args as ReadonlyArray<string>)
	return query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.searchSpans({
		serviceName: input.service,
		operation: input.operation,
		parentOperation: input.parentOperation,
		attributeFilters: input.attributeFilters,
		limit: config.otel.logFetchLimit,
	})))
}).pipe(Command.withDescription("Search spans by service, operation, parent, and attributes"))

const searchTraces = Command.make("search-traces", {
	args: Argument.string("service-or-filter").pipe(Argument.variadic),
}, ({ args }) => {
	const values = args as ReadonlyArray<string>
	const service = values[0] ?? config.otel.serviceName
	const operation = values[1] && !isAttributeFilterToken(values[1]) ? values[1] : undefined
	const attributeFilters = attributeFiltersFromArgs(values.slice(operation ? 2 : 1))
	return query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.searchTraces({
		serviceName: service,
		operation,
		attributeFilters,
		limit: config.otel.traceFetchLimit,
	})))
}).pipe(Command.withDescription("Search trace summaries by service, operation, and attributes"))

const traceStats = Command.make("trace-stats", {
	groupBy: Argument.string("groupBy"),
	agg: Argument.choice("aggregation", ["count", "avg_duration", "p95_duration", "error_rate"]),
	args: Argument.string("service-or-filter").pipe(Argument.variadic),
}, ({ groupBy, agg, args }) => {
	const values = args as ReadonlyArray<string>
	const service = values[0] && !isAttributeFilterToken(values[0]) ? values[0] : undefined
	return query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.traceStats({
		groupBy,
		agg,
		serviceName: service,
		attributeFilters: attributeFiltersFromArgs(values.slice(service ? 1 : 0)),
		limit: 20,
	})))
}).pipe(Command.withDescription("Aggregate trace metrics"))

const instructions = Command.make("instructions", {}, () => Console.log(otelServerInstructions()))
	.pipe(Command.withDescription("Print Effect telemetry setup instructions"))

const logs = Command.make("logs", {
	service: Argument.string("service").pipe(Argument.optional),
}, ({ service }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.listRecentLogs(optional(service, config.otel.serviceName)!))),
).pipe(Command.withDescription("List recent logs"))

const searchLogs = Command.make("search-logs", {
	args: Argument.string("service-or-filter").pipe(Argument.variadic),
}, ({ args }) => {
	const values = args as ReadonlyArray<string>
	const service = values[0] ?? config.otel.serviceName
	const body = values[1] && !isAttributeFilterToken(values[1]) ? values[1] : undefined
	return query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.searchLogs({
		serviceName: service,
		body,
		attributeFilters: attributeFiltersFromArgs(values.slice(body ? 2 : 1)),
		limit: config.otel.logFetchLimit,
	})))
}).pipe(Command.withDescription("Search logs by service, body, and attributes"))

const logStats = Command.make("log-stats", {
	groupBy: Argument.string("groupBy"),
	args: Argument.string("service-or-filter").pipe(Argument.variadic),
}, ({ groupBy, args }) => {
	const values = args as ReadonlyArray<string>
	const service = values[0] && !isAttributeFilterToken(values[0]) ? values[0] : undefined
	return query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.logStats({
		groupBy,
		agg: "count",
		serviceName: service,
		attributeFilters: attributeFiltersFromArgs(values.slice(service ? 1 : 0)),
		limit: 20,
	})))
}).pipe(Command.withDescription("Aggregate log metrics"))

const traceLogs = Command.make("trace-logs", {
	traceId: Argument.string("trace-id"),
}, ({ traceId }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.listTraceLogs(traceId))),
).pipe(Command.withDescription("List logs for one trace"))

const spanLogs = Command.make("span-logs", {
	spanId: Argument.string("span-id"),
}, ({ spanId }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.searchLogs({
		spanId,
		limit: config.otel.logFetchLimit,
	}))),
).pipe(Command.withDescription("List logs for one span"))

const facets = Command.make("facets", {
	type: Argument.choice("type", ["traces", "logs"]),
	field: Argument.string("field"),
}, ({ type, field }) =>
	query(Effect.flatMap(TelemetryStoreReadonly, (store) => store.listFacets({ type, field, limit: 20 }))),
).pipe(Command.withDescription("List facet values"))

const endpoints = Command.make("endpoints", {}, () => json({
	baseUrl: config.otel.baseUrl,
	exporterUrl: config.otel.exporterUrl,
	logsExporterUrl: config.otel.logsExporterUrl,
	queryUrl: config.otel.queryUrl,
	databasePath: config.otel.databasePath,
})).pipe(Command.withDescription("Print configured telemetry endpoints"))

export const queryCommands = [
	services,
	traces,
	trace,
	span,
	traceSpans,
	searchSpans,
	searchTraces,
	traceStats,
	instructions,
	logs,
	searchLogs,
	logStats,
	traceLogs,
	spanLogs,
	facets,
	endpoints,
] as const
