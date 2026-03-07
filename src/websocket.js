import { WebSocket } from "ws";
import config from "./config.js";
import { createServer, powerAction, deleteServer, getContainerIP } from "./docker.js";
import { attachConsole, sendCommand, detachConsole } from "./console.js";
import { startMetricsCollector } from "./metrics.js";
import { startProxy, stopProxy } from "./proxy.js";

let ws = null;
let reconnectTimer = null;
let isConnected = false;

/**
 * Send a message to the central API via WebSocket
 */
export function send(event, payload) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, payload, daemonId: config.daemonId }));
    }
}

/**
 * Connect to central API via WebSocket
 */
export function connectToAPI() {
    console.log(`[WS] Connecting to ${config.wsEndpoint}/ws/daemon...`);

    ws = new WebSocket(`${config.wsEndpoint}/ws/daemon`, {
        headers: {
            Authorization: `Bearer ${config.authToken}`,
            "X-Daemon-ID": config.daemonId,
            "X-Node-Name": config.nodeName,
        },
    });

    ws.on("open", () => {
        console.log("[WS] Connected to Central API ✓");
        isConnected = true;
        clearTimeout(reconnectTimer);

        // Authenticate
        send("daemon:auth", {
            daemonId: config.daemonId,
            nodeName: config.nodeName,
            token: config.authToken,
            version: "1.0.0",
        });

        // Start metrics broadcasting
        startMetricsCollector(send);
    });

    ws.on("message", async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            await handleMessage(msg);
        } catch (err) {
            console.error("[WS] Message parse error:", err.message);
        }
    });

    ws.on("close", (code) => {
        console.log(`[WS] Disconnected (code: ${code}). Reconnecting in 5s...`);
        isConnected = false;
        reconnectTimer = setTimeout(connectToAPI, 5000);
    });

    ws.on("error", (err) => {
        console.error("[WS] Error:", err.message);
    });
}

/**
 * Handle incoming messages from central API
 */
async function handleMessage({ event, payload }) {
    console.log(`[WS] ← ${event}`);

    try {
        switch (event) {
            // ── Server lifecycle ─────────────────
            case "server:create": {
                send("server:status", { serverId: payload.serverId, status: "installing" });

                const result = await createServer({
                    serverId: payload.serverId,
                    image: payload.image,
                    env: payload.env,
                    limits: payload.limits,
                    ports: payload.ports,
                });

                // Start TCP proxy for game ports
                if (payload.ports && payload.ports.length > 0) {
                    payload.ports.forEach((p) => {
                        startProxy({
                            serverId: payload.serverId,
                            listenPort: p.host,
                            containerIp: result.containerIp,
                            containerPort: p.container,
                        });
                    });
                }

                send("server:status", {
                    serverId: payload.serverId,
                    status: "running",
                    dockerId: result.containerId,
                });

                // Auto-attach console
                attachConsole(payload.serverId, result.containerId, (line) => {
                    send("server:console:output", { serverId: payload.serverId, line });
                });
                break;
            }

            case "server:power": {
                await powerAction(payload.dockerId, payload.action);
                const statusMap = {
                    start: "running",
                    stop: "stopped",
                    restart: "running",
                    kill: "stopped",
                };
                send("server:status", {
                    serverId: payload.serverId,
                    status: statusMap[payload.action],
                });

                // Manage proxy lifecycle
                if (payload.action === "stop" || payload.action === "kill") {
                    stopProxy(payload.serverId);
                } else if (payload.action === "start" || payload.action === "restart") {
                    try {
                        const containerIp = await getContainerIP(payload.dockerId);
                        if (payload.ports && payload.ports.length > 0) {
                            payload.ports.forEach((p) => {
                                startProxy({
                                    serverId: payload.serverId,
                                    listenPort: p.host,
                                    containerIp,
                                    containerPort: p.container,
                                });
                            });
                        }
                    } catch (proxyErr) {
                        console.error("[WS] Proxy restart error:", proxyErr.message);
                    }
                }

                // Re-attach console on start/restart
                if (["start", "restart"].includes(payload.action)) {
                    attachConsole(payload.serverId, payload.dockerId, (line) => {
                        send("server:console:output", { serverId: payload.serverId, line });
                    });
                }
                break;
            }

            case "server:delete": {
                stopProxy(payload.serverId);
                await deleteServer(payload.dockerId);
                detachConsole(payload.serverId, () => { });
                send("server:deleted", { serverId: payload.serverId });
                break;
            }

            // ── Console ──────────────────────────
            case "server:console:input": {
                await sendCommand(
                    payload.serverId,
                    payload.dockerId,
                    payload.command
                );
                break;
            }

            case "server:console:attach": {
                attachConsole(payload.serverId, payload.dockerId, (line) => {
                    send("server:console:output", { serverId: payload.serverId, line });
                });
                break;
            }

            // ── Reinstall ────────────────────────
            case "server:reinstall": {
                send("server:status", { serverId: payload.serverId, status: "installing" });
                stopProxy(payload.serverId);
                await deleteServer(payload.dockerId);

                const result = await createServer({
                    serverId: payload.serverId,
                    image: payload.image,
                    env: payload.env,
                    limits: payload.limits,
                    ports: payload.ports,
                });

                // Start TCP proxy for reinstalled server
                if (payload.ports && payload.ports.length > 0) {
                    payload.ports.forEach((p) => {
                        startProxy({
                            serverId: payload.serverId,
                            listenPort: p.host,
                            containerIp: result.containerIp,
                            containerPort: p.container,
                        });
                    });
                }

                send("server:status", {
                    serverId: payload.serverId,
                    status: "running",
                    dockerId: result.containerId,
                });
                break;
            }

            default:
                console.log(`[WS] Unknown event: ${event}`);
        }
    } catch (err) {
        console.error(`[WS] Handler error for ${event}:`, err.message);
        send("server:error", {
            serverId: payload?.serverId,
            event,
            error: err.message,
        });
    }
}

export function getConnectionStatus() {
    return isConnected;
}
