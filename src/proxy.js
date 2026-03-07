import net from "net";

/**
 * TCP Proxy Manager
 *
 * Instead of exposing container ports directly on the host via Docker PortBindings,
 * we run a lightweight TCP proxy on the allocated port. Traffic flows:
 *
 *   Player → Host:allocatedPort → [TCP Proxy] → ContainerIP:containerPort (Docker network)
 *
 * This keeps containers isolated on an internal Docker network while still
 * allowing players to connect on the same host:port as before.
 */

const activeProxies = new Map();

/**
 * Start a TCP proxy for a game server
 * @param {object} opts
 * @param {string} opts.serverId   - GHosting server UUID
 * @param {number} opts.listenPort - The host port players connect to
 * @param {string} opts.containerIp - Container IP on the ghosting-net network
 * @param {number} opts.containerPort - Port inside the container (e.g. 25565)
 */
export function startProxy({ serverId, listenPort, containerIp, containerPort }) {
    // Stop existing proxy if any
    stopProxy(serverId);

    const server = net.createServer((clientSocket) => {
        const upstream = net.createConnection({
            host: containerIp,
            port: containerPort,
        });

        // Pipe traffic bidirectionally
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);

        // Clean up on errors / close
        clientSocket.on("error", () => upstream.destroy());
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("close", () => upstream.destroy());
        upstream.on("close", () => clientSocket.destroy());
    });

    server.on("error", (err) => {
        console.error(`[Proxy:${serverId}] Server error on port ${listenPort}:`, err.message);
    });

    server.listen(listenPort, "0.0.0.0", () => {
        console.log(`[Proxy] Started: port ${listenPort} → ${containerIp}:${containerPort} (server: ${serverId})`);
    });

    activeProxies.set(serverId, {
        server,
        listenPort,
        containerIp,
        containerPort,
    });

    return { serverId, listenPort, containerIp, containerPort };
}

/**
 * Stop and remove a proxy for a game server
 */
export function stopProxy(serverId) {
    const proxy = activeProxies.get(serverId);
    if (!proxy) return;

    try {
        proxy.server.close();
    } catch { }

    activeProxies.delete(serverId);
    console.log(`[Proxy] Stopped: server ${serverId} (port ${proxy.listenPort})`);
}

/**
 * Update the target container IP for an existing proxy
 * (needed after container restart since IP may change)
 */
export function updateProxy(serverId, newContainerIp) {
    const proxy = activeProxies.get(serverId);
    if (!proxy) return;

    // Stop old and start new with updated IP
    const { listenPort, containerPort } = proxy;
    stopProxy(serverId);
    startProxy({ serverId, listenPort, containerIp: newContainerIp, containerPort });
}

/**
 * List all active proxies
 */
export function listProxies() {
    const proxies = [];
    for (const [serverId, proxy] of activeProxies) {
        proxies.push({
            serverId,
            listenPort: proxy.listenPort,
            containerIp: proxy.containerIp,
            containerPort: proxy.containerPort,
        });
    }
    return proxies;
}

/**
 * Check if a proxy exists for a server
 */
export function hasProxy(serverId) {
    return activeProxies.has(serverId);
}
