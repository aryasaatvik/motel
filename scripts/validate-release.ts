import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type PackResult = {
	readonly name: string
	readonly version: string
	readonly filename: string
	readonly files: ReadonlyArray<{ readonly path: string }>
}

type PackageManifest = {
	readonly name: string
	readonly version: string
	readonly repository: { readonly type: string; readonly url: string }
	readonly homepage: string
	readonly bugs: { readonly url: string }
	readonly bin: Record<string, string>
	readonly publishConfig: { readonly access: string; readonly registry: string }
}

const root = path.resolve(import.meta.dir, "..")
const temp = await mkdtemp(path.join(tmpdir(), "motel-release-"))
const packDir = path.join(temp, "pack")
const prefixDir = path.join(temp, "prefix")
const packageName = "@aryasaatvik/motel"
const repositoryUrl = "git+https://github.com/aryasaatvik/motel.git"

const run = async (
	cmd: ReadonlyArray<string>,
	cwd: string,
	options: { readonly stdin?: string; readonly env?: Record<string, string | undefined> } = {},
) => {
	const process = Bun.spawn(cmd, {
		cwd,
		env: options.env,
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])
	if (exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed (${exitCode})\n${stdout}${stderr}`)
	}
	return stdout
}

const smokeMcp = async (executable: string, cwd: string) => {
	const process = Bun.spawn([executable], {
		cwd,
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	})
	const exited = process.exited.then((exitCode) => ({ exitCode }))
	const result = await Promise.race([exited, Bun.sleep(500).then(() => null)])
	if (result) {
		const stderr = await new Response(process.stderr).text()
		throw new Error(`Packed motel-mcp exited during startup (${result.exitCode})\n${stderr}`)
	}
	process.kill()
	await process.exited
}

const assertPackageIdentity = (manifest: PackageManifest) => {
	if (manifest.name !== packageName) throw new Error(`Package name must be ${packageName}, received ${manifest.name}`)
	if (manifest.repository.type !== "git" || manifest.repository.url !== repositoryUrl) {
		throw new Error(`Package repository must be ${repositoryUrl}`)
	}
	if (manifest.homepage !== "https://github.com/aryasaatvik/motel#readme") {
		throw new Error("Package homepage must point to the owned repository")
	}
	if (manifest.bugs.url !== "https://github.com/aryasaatvik/motel/issues") {
		throw new Error("Package bugs URL must point to the owned repository")
	}
	if (manifest.publishConfig.access !== "public" || manifest.publishConfig.registry !== "https://registry.npmjs.org/") {
		throw new Error("Package publish configuration must target the public npm registry")
	}
	const expectedBins = { motel: "src/motel.ts", "motel-mcp": "src/mcp.ts" }
	if (JSON.stringify(manifest.bin) !== JSON.stringify(expectedBins)) {
		throw new Error("Package must expose only the motel and motel-mcp bins")
	}
	if (process.env.GITHUB_ACTIONS === "true") {
		const expectedTag = `v${manifest.version}`
		if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== expectedTag) {
			throw new Error(`GitHub releases must run from ${expectedTag}`)
		}
	}
}

try {
	await mkdir(packDir)
	await mkdir(prefixDir)
	await run(["bun", "run", "web:build"], root)
	const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageManifest
	assertPackageIdentity(packageJson)

	const packOutput = await run(
		["npm", "pack", "--json", "--pack-destination", packDir],
		root,
	)
	const [packed] = JSON.parse(packOutput) as PackResult[]
	if (!packed) throw new Error("npm pack did not produce an artifact")
	if (packed.name !== packageJson.name || packed.version !== packageJson.version) {
		throw new Error("Packed artifact metadata does not match package.json")
	}

	const included = new Set(packed.files.map((file) => file.path))
	for (const required of [
		"skills/motel-debug/SKILL.md",
		"skills/motel-debug/references/effect.md",
		"src/motel.ts",
		"src/mcp.ts",
		"web/dist/index.html",
	]) {
		if (!included.has(required)) throw new Error(`Packed artifact is missing ${required}`)
	}

	const tarball = path.join(packDir, packed.filename)
	await Bun.write(
		path.join(prefixDir, "package.json"),
		JSON.stringify({ private: true }, null, 2),
	)
	await run(["npm", "install", "--prefix", prefixDir, "--no-save", "--ignore-scripts", tarball], root)

	const motel = path.join(prefixDir, "node_modules", ".bin", "motel")
	const motelMcp = path.join(prefixDir, "node_modules", ".bin", "motel-mcp")
	const help = await run([motel, "--help"], prefixDir)
	if (!help.includes("motel <subcommand>") || !help.includes("daemon, start") || !help.includes("service")) {
		throw new Error("Packed motel binary did not print the expected Effect CLI command tree")
	}
	const runtimeDir = path.join(temp, "runtime")
	await mkdir(runtimeDir)
	const runtimeEnv = {
		...process.env,
		MOTEL_RUNTIME_DIR: runtimeDir,
		MOTEL_OTEL_DB_PATH: path.join(runtimeDir, "telemetry.sqlite"),
	}
	const installedRoot = path.join(prefixDir, "node_modules", ...packageJson.name.split("/"))
	await run([
		"bun",
		"-e",
		`const { Effect } = await import("effect"); const { storeRuntime } = await import(${JSON.stringify(path.join(installedRoot, "src", "runtime.ts"))}); const { TelemetryStore } = await import(${JSON.stringify(path.join(installedRoot, "src", "services", "TelemetryStore.ts"))}); await storeRuntime.runPromise(Effect.flatMap(TelemetryStore, (store) => store.listServices)); await storeRuntime.dispose()`,
	], prefixDir, { env: runtimeEnv })
	try {
		const services = await run([motel, "services"], prefixDir, { env: runtimeEnv })
		if (!services.trim().startsWith("[")) throw new Error("Packed motel binary did not query services")
	} finally {
		await run([motel, "stop"], prefixDir, { env: runtimeEnv }).catch(() => undefined)
	}
	await smokeMcp(motelMcp, prefixDir)

	const reportedVersion = await run(
		["bun", "-e", `import { MOTEL_VERSION } from ${JSON.stringify(path.join(installedRoot, "src", "registry.ts"))}; console.log(MOTEL_VERSION)`],
		prefixDir,
	)
	if (reportedVersion.trim() !== packageJson.version) {
		throw new Error(`Runtime version ${reportedVersion.trim()} does not match package version ${packageJson.version}`)
	}

	console.log(`Validated ${packed.filename} from an isolated temporary prefix`)
} finally {
	await rm(temp, { recursive: true, force: true })
}
