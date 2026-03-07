import config from "./config.js";
import { startHTTPServer } from "./http.js";
import { isFRPAvailable } from "./frp.js";

/**
 * ╔═══════════════════════════════════════╗
 * ║   CloudNode Daemon v1.0.0            ║
 * ║   Server Node Manager                ║
 * ╚═══════════════════════════════════════╝
 *
 * Modules:
 *   - docker.js     → Container lifecycle (create, start, stop, delete)
 *   - metrics.js    → System & container metrics collection
 *   - console.js    → Console session management & log streaming
 *   - http.js       → HTTP API server
 *   - frp.js        → FRP tunnel management for public access
 *   - config.js     → Environment configuration
 */

console.log(`
  ╔═══════════════════════════════════════╗
  ║   CloudNode Daemon v1.0.0             ║
  ║   Node: ${config.nodeName.padEnd(30)}║
  ║   ID:   ${config.daemonId.substring(0, 30).padEnd(30)}║
  ╚═══════════════════════════════════════╝
`);

console.log(`[Daemon] Config:`);
console.log(`  HTTP Port:     ${config.httpPort}`);
console.log(`  Docker Socket: ${config.dockerSocket}`);
console.log(`  Data Dir:      ${config.dataDir}`);
console.log(`  FRP Enabled:   ${config.frpEnabled}`);

if (config.frpEnabled) {
    const frpAvailable = isFRPAvailable();
    console.log(`  FRP Binary:    ${frpAvailable ? "✓ Available" : "✗ Not found"}`);
}

console.log("");

// Start HTTP server
startHTTPServer();

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[Daemon] Shutting down...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n[Daemon] Terminated");
    process.exit(0);
});

process.on("uncaughtException", (err) => {
    console.error("[Daemon] Uncaught exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("[Daemon] Unhandled rejection:", err);
});
