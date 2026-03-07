import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config.js";

/**
 * FRP (Fast Reverse Proxy) Manager
 *
 * Manages frpc instances to expose game server ports
 * through the central FRP server for public access.
 */

const activeTunnels = new Map();

/**
 * Create an FRP tunnel for a game server
 */
export async function createTunnel({ serverId, localPort, remotePort, subdomain, protocol = "tcp" }) {
    if (!config.frpEnabled) {
        console.log("[FRP] FRP is disabled, skipping tunnel creation");
        return null;
    }

    const configContent = `
[common]
server_addr = ${config.frpServerAddr}
server_port = ${config.frpServerPort}
token = ${config.frpToken}

[${serverId}]
type = ${protocol}
local_ip = 127.0.0.1
local_port = ${localPort}
remote_port = ${remotePort}
${subdomain ? `subdomain = ${subdomain}` : ""}
`;

    const configDir = path.join(config.dataDir, "frp");
    const configFile = path.join(configDir, `${serverId}.ini`);

    // Ensure config directory exists
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, configContent.trim());

    // Spawn frpc process
    const frpcProcess = spawn("frpc", ["-c", configFile], {
        stdio: "pipe",
        detached: true,
    });

    frpcProcess.stdout.on("data", (data) => {
        console.log(`[FRP:${serverId}] ${data.toString().trim()}`);
    });

    frpcProcess.stderr.on("data", (data) => {
        console.error(`[FRP:${serverId}] ${data.toString().trim()}`);
    });

    frpcProcess.on("exit", (code) => {
        console.log(`[FRP:${serverId}] Process exited with code ${code}`);
        activeTunnels.delete(serverId);
    });

    activeTunnels.set(serverId, {
        process: frpcProcess,
        configFile,
        localPort,
        remotePort,
        subdomain,
    });

    console.log(`[FRP] Tunnel created: ${serverId} (local:${localPort} → remote:${remotePort})`);

    return {
        serverId,
        localPort,
        remotePort,
        subdomain,
        publicAddr: `${config.frpServerAddr}:${remotePort}`,
    };
}

/**
 * Remove an FRP tunnel
 */
export function removeTunnel(serverId) {
    const tunnel = activeTunnels.get(serverId);
    if (!tunnel) return;

    // Kill frpc process
    try {
        tunnel.process.kill("SIGTERM");
    } catch { }

    // Remove config file
    try {
        fs.unlinkSync(tunnel.configFile);
    } catch { }

    activeTunnels.delete(serverId);
    console.log(`[FRP] Tunnel removed: ${serverId}`);
}

/**
 * List active tunnels
 */
export function listTunnels() {
    const tunnels = [];
    for (const [serverId, tunnel] of activeTunnels) {
        tunnels.push({
            serverId,
            localPort: tunnel.localPort,
            remotePort: tunnel.remotePort,
            subdomain: tunnel.subdomain,
        });
    }
    return tunnels;
}

/**
 * Check if frpc binary is available
 */
export function isFRPAvailable() {
    try {
        execSync("frpc --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}
