import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import rootPackage from "../package.json" with { type: "json" }

const expectedVersion = `${rootPackage.version}\n`

const motel = async (...args: ReadonlyArray<string>) => {
	const child = Bun.spawn({
		cmd: [process.execPath, "run", "src/motel.ts", ...args],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

const assertMcpStartsCleanly = async (cmd: ReadonlyArray<string>, cwd = process.cwd()) => {
	const process = Bun.spawn({ cmd: [...cmd], cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	const earlyExit = await Promise.race([process.exited.then((exitCode) => ({ exitCode })), Bun.sleep(500).then(() => null)])
	expect(earlyExit).toBeNull()
	process.kill()
	await process.exited
	expect(await new Response(process.stdout).text()).toBe("")
	expect(await new Response(process.stderr).text()).toBe("")
}

describe("motel command tree", () => {
	test("renders native root and subcommand help", async () => {
		const root = await motel("--help")
		expect(root.exitCode).toBe(0)
		expect(root.stdout).toContain("motel <subcommand>")
		expect(root.stdout).not.toContain("bun run cli")
		expect(root.stderr).toBe("")

		const leaf = await motel("trace-stats", "--help")
		expect(leaf.exitCode).toBe(0)
		expect(leaf.stdout).toContain("motel trace-stats")
		expect(leaf.stderr).toBe("")

		const service = await motel("service", "install", "--help")
		expect(service.exitCode).toBe(0)
		expect(service.stdout).toContain("motel service install")
		expect(service.stdout).toContain("--replace")
		expect(service.stderr).toBe("")
	})

	test("keeps both version aliases to the bare package version", async () => {
		for (const flag of ["--version", "-v"]) {
			const result = await motel(flag)
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toBe(expectedVersion)
			expect(result.stderr).toBe("")
		}
	})

	test("renders focused usage for invalid command and enum input", async () => {
		const unknown = await motel("not-a-command")
		expect(unknown.exitCode).toBe(1)
		expect(unknown.stdout).toContain("motel <subcommand>")
		expect(unknown.stderr).toContain('Unknown subcommand "not-a-command"')

		const invalidAggregation = await motel("trace-stats", "service", "nope")
		expect(invalidAggregation.exitCode).toBe(1)
		expect(invalidAggregation.stdout).toContain("motel trace-stats")
		expect(invalidAggregation.stderr).toContain('Invalid value for argument <aggregation>: "nope"')

		const invalidFilter = await motel("search-traces", "attr.bad")
		expect(invalidFilter.exitCode).toBe(1)
		expect(invalidFilter.stdout).toContain("motel search-traces")
		expect(invalidFilter.stderr).toContain("attribute filters must use attr.<key>=<value>")
	})

	test("prints JSON command output without CLI banners", async () => {
		const result = await motel("endpoints")
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toMatchObject({
			baseUrl: "http://127.0.0.1:27686",
			queryUrl: "http://127.0.0.1:27686",
		})
	})

	test("keeps the MCP command path protocol-clean", async () => {
		await assertMcpStartsCleanly([process.execPath, "run", "src/motel.ts", "mcp"])
		await assertMcpStartsCleanly([process.execPath, "run", "src/mcp.ts"])
	})

	test("keeps the foreground server alive until it receives a signal", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-server-cli-"))
		const port = 30000 + Math.floor(Math.random() * 1000)
		const server = Bun.spawn({
			cmd: [process.execPath, "run", "src/motel.ts", "server"],
			cwd: process.cwd(),
			env: {
				...process.env,
				MOTEL_RUNTIME_DIR: runtimeDir,
				MOTEL_OTEL_DB_PATH: path.join(runtimeDir, "telemetry.sqlite"),
				MOTEL_OTEL_PORT: String(port),
				MOTEL_OTEL_BASE_URL: `http://127.0.0.1:${port}`,
				MOTEL_OTEL_QUERY_URL: `http://127.0.0.1:${port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		try {
			let healthy = false
			for (let attempt = 0; attempt < 40; attempt++) {
				try {
					const response = await fetch(`http://127.0.0.1:${port}/api/health`)
					healthy = response.ok
				} catch {
					await Bun.sleep(25)
				}
				if (healthy) break
			}
			expect(healthy).toBe(true)
			expect(await Promise.race([server.exited, Bun.sleep(50).then(() => null)])).toBeNull()
		} finally {
			server.kill("SIGTERM")
			await server.exited
			fs.rmSync(runtimeDir, { recursive: true, force: true })
		}
	})

	test("runs the packed motel binary from an isolated temporary prefix", async () => {
		const temporaryPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "motel-installed-cli-"))
		try {
			const pack = Bun.spawn({
				cmd: ["bun", "pm", "pack", "--destination", temporaryPrefix, "--quiet"],
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(await pack.exited, await new Response(pack.stderr).text()).toBe(0)
			const tarball = fs.readdirSync(temporaryPrefix).find((entry) => entry.endsWith(".tgz"))
			expect(tarball).toBeDefined()

			const prefix = path.join(temporaryPrefix, "prefix")
			fs.mkdirSync(prefix)
			const install = Bun.spawn({
				cmd: ["bun", "install", "--cwd", prefix, path.join(temporaryPrefix, tarball!)],
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(await install.exited, await new Response(install.stderr).text()).toBe(0)

			const installed = Bun.spawn({
				cmd: [path.join(prefix, "node_modules/.bin/motel"), "--version"],
				cwd: prefix,
				stdout: "pipe",
				stderr: "pipe",
			})
			const [exitCode, stdout, stderr] = await Promise.all([
				installed.exited,
				new Response(installed.stdout).text(),
				new Response(installed.stderr).text(),
			])
			expect(exitCode).toBe(0)
			expect(stdout).toBe(expectedVersion)
			expect(stderr).toBe("")
			await assertMcpStartsCleanly([path.join(prefix, "node_modules/.bin/motel"), "mcp"], prefix)
			await assertMcpStartsCleanly([path.join(prefix, "node_modules/.bin/motel-mcp")], prefix)
		} finally {
			fs.rmSync(temporaryPrefix, { recursive: true, force: true })
		}
	})
})
