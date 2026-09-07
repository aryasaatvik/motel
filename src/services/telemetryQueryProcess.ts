// Keep the IPC owner outside SQLite's native call stack. If the daemon/TUI exits
// unexpectedly, disconnect can terminate this process even while its thread is
// executing a long SQLite query. A worker thread alone cannot interrupt that call.
const worker = new Worker(new URL("./telemetryQueryWorker.ts", import.meta.url))
worker.addEventListener("message", ({ data }) => process.send?.(data))
worker.addEventListener("error", () => process.exit(1))
worker.addEventListener("close", () => process.exit(1))
process.on("message", (message) => worker.postMessage(message))
process.on("disconnect", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
