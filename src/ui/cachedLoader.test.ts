import { describe, expect, it } from "bun:test"
import { makeCachedLoader } from "./cachedLoader.ts"

describe("makeCachedLoader", () => {
	it("ensures cached values without loading twice", async () => {
		let loads = 0
		const loader = makeCachedLoader<string, number>({ load: async () => ++loads })

		expect(await loader.ensure("key")).toBe(1)
		expect(await loader.ensure("key")).toBe(1)
		expect(loads).toBe(1)
	})

	it("refreshes stale values while publishing the updated cache", async () => {
		let value = 1
		const loader = makeCachedLoader<string, number>({ load: async () => value })

		expect(await loader.ensure("key")).toBe(1)
		value = 2
		expect(await loader.refresh("key")).toBe(2)
		expect(loader.get("key")).toBe(2)
	})
})

it("refresh and invalidation coalesce an in-flight request without stale cleanup deleting its successor", async () => {
	let resolve: (value: number) => void = () => {}
	let loads = 0
	const loader = makeCachedLoader<string, number>({ load: () => { loads++; return new Promise((done) => { resolve = done }) } })
	const first = loader.ensure("key")
	loader.invalidate()
	expect(loader.refresh("key")).toBe(first)
	expect(loader.ensure("key")).toBe(first)
	expect(loads).toBe(1)
	resolve(1)
	expect(await first).toBe(1)
	expect(loader.get("key")).toBe(1)
	const second = loader.refresh("key")
	expect(loads).toBe(2)
	expect(loader.refresh("key")).toBe(second)
	resolve(2)
	await second
	expect(loader.get("key")).toBe(2)
})
