import { Effect } from "effect"
import { config } from "../config.ts"
import { queryRuntime } from "../runtime.ts"
import { TelemetryStoreReadonly } from "../services/TelemetryStore.ts"
import { makeCachedLoader } from "./cachedLoader.ts"

// Refreshes join matching in-flight work; settled results are not retained here.
const pendingLoads = new Map<string, Promise<unknown>>()
const query = <A>(key: readonly unknown[], effect: Effect.Effect<A, Error, TelemetryStoreReadonly>): Promise<A> => {
	const hash = JSON.stringify(key)
	const existing = pendingLoads.get(hash)
	if (existing) return existing as Promise<A>
	const request = queryRuntime.runPromise(effect).finally(() => pendingLoads.delete(hash))
	pendingLoads.set(hash, request)
	return request
}

export const loadTraceServices = () =>
	query(["services"], Effect.flatMap(TelemetryStoreReadonly, (service) => service.listServices))

export const loadRecentTraceSummaries = (serviceName: string) =>
	query(["summaries", serviceName], Effect.flatMap(TelemetryStoreReadonly, (service) => service.listTraceSummaries(serviceName)))

/**
 * Server-side trace summary search. Accepts any combination of:
 *
 * - `attributeFilters` — exact-match span attributes (from the `f` picker)
 * - `aiText`           — FTS5-backed search across LLM prompt/response
 *                        content (AI_FTS_KEYS), from the `:ai <query>`
 *                        modifier in the `/` filter
 *
 * Both filters compose: when both are set, a trace must match both. When
 * neither is set, callers should prefer `loadRecentTraceSummaries` so
 * the server can skip the search path entirely.
 */
export const loadFilteredTraceSummaries = (
	serviceName: string,
	options: {
		readonly attributeFilters?: Readonly<Record<string, string>>
		readonly aiText?: string | null
	},
) =>
	query(["summaries", serviceName, options], Effect.flatMap(TelemetryStoreReadonly, (service) => service.searchTraceSummaries({
		serviceName,
		attributeFilters: options.attributeFilters,
		aiText: options.aiText ?? null,
		limit: config.otel.traceFetchLimit,
	})))

export const loadTraceAttributeKeys = (serviceName: string) =>
	queryRuntime.runPromise(Effect.flatMap(TelemetryStoreReadonly, (service) => service.listFacets({ type: "traces", field: "attribute_keys", serviceName, limit: 200 })))

export const loadTraceAttributeValues = (serviceName: string, key: string) =>
	queryRuntime.runPromise(Effect.flatMap(TelemetryStoreReadonly, (service) => service.listFacets({ type: "traces", field: "attribute_values", serviceName, key, limit: 200 })))

// ---------------------------------------------------------------------------
// Facet cache (drives the `f` attribute filter picker)
// ---------------------------------------------------------------------------

export interface FacetRow {
	readonly value: string
	readonly count: number
}

export interface FacetCacheEntry {
	readonly data: readonly FacetRow[]
	readonly fetchedAt: Date
}

const wrapWithTimestamp = (data: readonly FacetRow[]): FacetCacheEntry => ({ data, fetchedAt: new Date() })

const facetKeysLoader = makeCachedLoader<string, FacetCacheEntry>({
	load: (service) => loadTraceAttributeKeys(service).then(wrapWithTimestamp),
})

const facetValuesLoader = makeCachedLoader<{ readonly service: string; readonly key: string }, FacetCacheEntry>({
	hash: ({ service, key }) => `${service}\u0000${key}`,
	load: ({ service, key }) => loadTraceAttributeValues(service, key).then(wrapWithTimestamp),
})

export const getCachedFacetKeys = (service: string): FacetCacheEntry | null =>
	facetKeysLoader.get(service) ?? null

export const getCachedFacetValues = (service: string, key: string): FacetCacheEntry | null =>
	facetValuesLoader.get({ service, key }) ?? null

export const ensureTraceAttributeKeys = (service: string): Promise<FacetCacheEntry> =>
	facetKeysLoader.ensure(service)

export const refreshTraceAttributeKeys = (service: string): Promise<FacetCacheEntry> =>
	facetKeysLoader.refresh(service)

export const ensureTraceAttributeValues = (service: string, key: string): Promise<FacetCacheEntry> =>
	facetValuesLoader.ensure({ service, key })

export const refreshTraceAttributeValues = (service: string, key: string): Promise<FacetCacheEntry> =>
	facetValuesLoader.refresh({ service, key })

/** Called from the refreshNonce effect alongside the trace / log cache clears. */
export const invalidateFacetCaches = () => {
	facetKeysLoader.invalidate()
	facetValuesLoader.invalidate()
}

export const loadTraceDetail = (traceId: string) =>
	query(["trace", traceId], Effect.flatMap(TelemetryStoreReadonly, (service) => service.getTrace(traceId)))

export const loadTraceLogs = (traceId: string) =>
	query(["trace-logs", traceId], Effect.flatMap(TelemetryStoreReadonly, (service) => service.listTraceLogs(traceId)))

export const loadServiceLogs = (serviceName: string) =>
	query(["service-logs", serviceName], Effect.flatMap(TelemetryStoreReadonly, (service) => service.listRecentLogs(serviceName)))
