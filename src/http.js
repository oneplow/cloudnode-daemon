import http from "http";
import path from "path";
import fs from "fs";
import busboy from "busboy";
import config from "./config.js";
import { getNodeMetrics, getServerMetrics } from "./metrics.js";
import { docker, createServer, powerAction, deleteServer, getContainerStats, listManagedContainers, getContainerIP, upgradeServer } from "./docker.js";
import { getDirectorySize, listFiles, readFile, writeFile, createFileOrDir, deleteFileOrDir, getSafePath } from "./files.js";
import { createBackup, listBackups, deleteBackup, restoreBackup } from "./backup.js";
import { startProxy, stopProxy, updateProxy } from "./proxy.js";

/**
 * HTTP API Server
 * Handles direct requests from the central API (backup for WebSocket)
 */
export function startHTTPServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

        // Log incoming request
        if (pathname !== "/api/metrics") { // Ignore frequent metrics polling
            console.log(`[HTTP] ${req.method} ${pathname} from ${clientIp}`);
        }

        // Auth check - handled first
        const authHeader = req.headers.authorization;
        const urlToken = url.searchParams.get("token");

        if (authHeader !== `Bearer ${config.authToken}` && urlToken !== config.authToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Unauthorized" }));
            return;
        }

        try {
            // ── Health ──────────────────────────
            if (pathname === "/api/health" && req.method === "GET") {
                const metrics = await getNodeMetrics();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: "ok",
                    daemon: config.daemonId,
                    nodeName: config.nodeName,
                    ...metrics,
                }));
                return;
            }

            // ── Health stream (SSE) ───────────────────
            if (pathname === "/api/health/stream" && req.method === "GET") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*"
                });

                const sendMetrics = async () => {
                    try {
                        const metrics = await getNodeMetrics();
                        res.write(`data: ${JSON.stringify({
                            status: "ok",
                            daemon: config.daemonId,
                            nodeName: config.nodeName,
                            ...metrics,
                        })}\n\n`);
                    } catch (e) {
                        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
                    }
                };

                sendMetrics(); // Send initial
                const intervalId = setInterval(() => {
                    if (res.writableEnded) {
                        clearInterval(intervalId);
                        return;
                    }
                    sendMetrics();
                }, 5000);

                req.on("close", () => clearInterval(intervalId));
                return;
            }

            // ── Server upgrade ─────────────────
            const upgradeMatch = pathname.match(/^\/api\/servers\/(.+)\/upgrade$/);
            if (upgradeMatch && req.method === "POST") {
                try {
                    const body = await readBody(req);
                    const { limits } = JSON.parse(body);

                    await upgradeServer(upgradeMatch[1], limits);

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Failed to upgrade server limits", error: e.message }));
                }
                return;
            }

            // ── Server power ───────────────────
            const powerMatch = pathname.match(/^\/api\/servers\/(.+)\/power$/);
            if (powerMatch && req.method === "POST") {
                const body = await readBody(req);
                const { action, diskLimit } = JSON.parse(body);
                const containerId = powerMatch[1];

                // Enforce desk storage limit before starting
                if (action === "start" && diskLimit) {
                    try {
                        const container = docker.getContainer(containerId);
                        const info = await container.inspect();
                        const serverId = info.Config.Labels["ghosting.server_id"];

                        if (serverId) {
                            const dataPath = path.resolve(config.dataDir, serverId);
                            const currentSize = await getDirectorySize(dataPath);
                            const limitBytes = diskLimit * 1024 * 1024;

                            if (currentSize > limitBytes) {
                                res.writeHead(403, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({
                                    message: `Storage limit exceeded. Used: ${(currentSize / 1024 / 1024).toFixed(2)} MB, Limit: ${diskLimit} MB. Please upgrade your plan or delete some files.`
                                }));
                                return;
                            }
                        }
                    } catch (err) {
                        console.error("[HTTP] Error checking disk limit before start:", err.message);
                        // Continue to start if we can't verify (fallback)
                    }
                }

                await powerAction(containerId, action);

                // Manage proxy lifecycle on power actions
                if (action === "stop" || action === "kill") {
                    // Get serverId from container labels
                    try {
                        const container = docker.getContainer(containerId);
                        const info = await container.inspect();
                        const sId = info.Config.Labels["ghosting.server_id"];
                        if (sId) stopProxy(sId);
                    } catch { }
                } else if (action === "start" || action === "restart") {
                    // Re-start proxy with updated container IP
                    try {
                        const container = docker.getContainer(containerId);
                        const info = await container.inspect();
                        const sId = info.Config.Labels["ghosting.server_id"];
                        if (sId) {
                            const containerIp = await getContainerIP(containerId);
                            // Get the allocated port from query params or body
                            const bodyData = JSON.parse(body);
                            if (bodyData.allocatedPort && bodyData.containerPort) {
                                startProxy({
                                    serverId: sId,
                                    listenPort: bodyData.allocatedPort,
                                    containerIp,
                                    containerPort: bodyData.containerPort,
                                });
                            }
                        }
                    } catch (proxyErr) {
                        console.error("[HTTP] Proxy restart error:", proxyErr.message);
                    }
                }

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
                return;
            }

            // ── Server stats stream (SSE) ──────
            const statsStreamMatch = pathname.match(/^\/api\/servers\/(.+)\/stats\/stream$/);
            if (statsStreamMatch && req.method === "GET") {
                const containerId = statsStreamMatch[1];
                let isClosing = false;

                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*"
                });

                const sendInitialStats = async () => {
                    try {
                        const initialStats = await getContainerStats(containerId);
                        if (!isClosing) res.write(`data: ${JSON.stringify(initialStats)}\n\n`);
                    } catch (e) {
                        // Container might be offline/deleted, send 0 stats
                        if (!isClosing) res.write(`data: ${JSON.stringify({ cpu: 0, memory: 0, disk: 0, network: { rx: 0, tx: 0 }, isOffline: true })}\n\n`);
                    }
                };

                sendInitialStats();

                const intervalId = setInterval(async () => {
                    if (res.writableEnded || isClosing) {
                        clearInterval(intervalId);
                        return;
                    }
                    try {
                        const stats = await getContainerStats(containerId);
                        if (!isClosing) res.write(`data: ${JSON.stringify(stats)}\n\n`);
                    } catch (e) {
                        // Send zeroed stats if stopped
                        if (!isClosing) res.write(`data: ${JSON.stringify({ cpu: 0, memory: 0, disk: 0, network: { rx: 0, tx: 0 }, isOffline: true })}\n\n`);
                    }
                }, 3000);

                req.on("close", () => {
                    isClosing = true;
                    clearInterval(intervalId);
                });
                return;
            }

            // ── Server stats ───────────────────
            const statsMatch = pathname.match(/^\/api\/servers\/(.+)\/stats$/);
            if (statsMatch && req.method === "GET") {
                const stats = await getContainerStats(statsMatch[1]);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(stats));
                return;
            }

            // ── List/Create containers ────────────────
            if (pathname === "/api/servers") {
                if (req.method === "GET") {
                    const containers = await listManagedContainers();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ containers }));
                    return;
                }

                if (req.method === "POST") {
                    const body = await readBody(req);
                    const { serverId, image, env, limits, ports, envType, cmd } = JSON.parse(body);

                    try {
                        const result = await createServer({ serverId, image, env, limits, ports, envType, cmd });

                        // Start TCP proxy for the game port
                        if (ports && ports.length > 0) {
                            ports.forEach((p) => {
                                startProxy({
                                    serverId,
                                    listenPort: p.host,
                                    containerIp: result.containerIp,
                                    containerPort: p.container,
                                });
                            });
                        }

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                    } catch (e) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Failed to create container: " + e.message }));
                    }
                    return;
                }
            }


            // ── Servers metrics ────────────────
            if (pathname === "/api/metrics" && req.method === "GET") {
                const serverMetrics = await getServerMetrics();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ metrics: serverMetrics }));
                return;
            }

            // ── Files ──────────────────────────
            const filesMatch = pathname.match(/^\/api\/servers\/(.+)\/files$/);
            if (filesMatch) {
                const serverId = filesMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                if (req.method === "GET") {
                    const files = await listFiles(serverId, reqPath);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(files));
                    return;
                }

                if (req.method === "POST") {
                    const body = await readBody(req);
                    const { isDir } = JSON.parse(body);
                    await createFileOrDir(serverId, reqPath, isDir);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                if (req.method === "DELETE") {
                    try {
                        const body = await readBody(req).catch(() => null);
                        if (body) {
                            const { paths } = JSON.parse(body);
                            if (Array.isArray(paths)) {
                                console.log(`[HTTP] Bulk delete for ${serverId}: ${paths.length} items`);
                                for (const p of paths) {
                                    await deleteFileOrDir(serverId, p);
                                }
                                res.writeHead(200, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({ success: true }));
                                return;
                            }
                        }
                    } catch (e) { }

                    await deleteFileOrDir(serverId, reqPath);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }
            }

            const fileContentMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/content$/);
            if (fileContentMatch) {
                const serverId = fileContentMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                try {
                    if (req.method === "GET") {
                        const content = await readFile(serverId, reqPath);
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(content);
                        return;
                    }

                    if (req.method === "PUT") {
                        const body = await readBody(req);
                        const { content } = JSON.parse(body);
                        await writeFile(serverId, reqPath, content);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "File error: " + e.message }));
                    return;
                }
            }

            // ── File Download ────────────────────
            const downloadMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/download$/);
            if (downloadMatch && req.method === "GET") {
                const serverId = downloadMatch[1];
                const reqPath = url.searchParams.get("path") || "/";
                try {
                    const { targetPath } = getSafePath(serverId, reqPath);
                    const stat = fs.statSync(targetPath);
                    if (!stat.isFile()) throw new Error("Not a file");

                    res.writeHead(200, {
                        "Content-Type": "application/octet-stream",
                        "Content-Length": stat.size,
                        "Content-Disposition": `attachment; filename="${path.basename(targetPath)}"`
                    });
                    const fileStream = fs.createReadStream(targetPath);
                    fileStream.pipe(res);
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                }
                return;
            }

            // ── File Upload ──────────────────────
            const uploadMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/upload$/);
            if (uploadMatch && req.method === "POST") {
                const serverId = uploadMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                try {
                    const { targetPath } = getSafePath(serverId, reqPath);
                    const bb = busboy({ headers: req.headers });
                    let savedCount = 0;

                    bb.on("file", (name, file, info) => {
                        const { filename } = info;
                        const saveTo = path.join(targetPath, filename);
                        file.pipe(fs.createWriteStream(saveTo));
                        file.on("end", () => {
                            savedCount++;
                        });
                    });

                    bb.on("finish", () => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true, count: savedCount }));
                    });

                    bb.on("error", (err) => {
                        if (!res.headersSent) {
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ message: err.message }));
                        }
                    });

                    req.pipe(bb);
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                }
                return;
            }

            // ── Backups ────────────────────────────
            const backupsMatch = pathname.match(/^\/api\/servers\/(.+)\/backups\/?(.*)$/);
            if (backupsMatch) {
                const serverId = backupsMatch[1]; // Correct UUID passed from Web
                const actionParam = backupsMatch[2]; // e.g. "", "xyz.tar.gz", "xyz.tar.gz/restore"

                try {
                    //console.log(`[HTTP] Backup action: ${req.method} for Server: ${serverId}, Action: ${actionParam}`);

                    if (req.method === "GET" && !actionParam) {
                        const backups = await listBackups(serverId);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(backups));
                        return;
                    }

                    if (req.method === "POST" && !actionParam) {
                        let bodyName = "backup";
                        try {
                            const body = await readBody(req);
                            if (body && body.trim() !== "") {
                                const parsed = JSON.parse(body);
                                if (parsed.name) bodyName = parsed.name;
                            }
                        } catch (e) { }

                        const backupInfo = await createBackup(serverId, bodyName);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(backupInfo));
                        return;
                    }

                    if (req.method === "DELETE" && actionParam) {
                        await deleteBackup(serverId, actionParam);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }

                    if (req.method === "POST" && actionParam.endsWith("/restore")) {
                        const filename = actionParam.replace("/restore", "");
                        await restoreBackup(serverId, filename);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }
                } catch (e) {
                    console.error(`[HTTP] Backup error:`, e.message);
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                    return;
                }
            }

            // ── Console SSE Stream ─────────────
            const consoleStreamMatch = pathname.match(/^\/api\/servers\/(.+)\/console\/stream$/);
            if (consoleStreamMatch && req.method === "GET") {
                const containerId = consoleStreamMatch[1];
                try {
                    const container = docker.getContainer(containerId);
                    const info = await container.inspect();
                    const serverId = info.Config.Labels["ghosting.server_id"];
                    const isTty = info.Config.Tty;

                    if (!serverId) throw new Error("Not a managed server");

                    res.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    });

                    // Send initial connected event
                    res.write(`data: ${JSON.stringify({ event: "connected", serverId })}\n\n`);

                    // Stream container logs
                    const stream = await container.logs({
                        follow: true,
                        stdout: true,
                        stderr: true,
                        tail: 100,
                    });

                    const parseChunk = (chunk) => {
                        if (isTty) return chunk.toString("utf8");
                        let text = "";
                        let offset = 0;
                        while (offset < chunk.length) {
                            if (chunk.length - offset >= 8 &&
                                (chunk[offset] === 1 || chunk[offset] === 2) &&
                                chunk[offset + 1] === 0 &&
                                chunk[offset + 2] === 0 &&
                                chunk[offset + 3] === 0) {
                                const size = chunk.readUInt32BE(offset + 4);
                                if (size > 0 && offset + 8 + size <= chunk.length) {
                                    text += chunk.toString("utf8", offset + 8, offset + 8 + size);
                                    offset += 8 + size;
                                    continue;
                                }
                            }
                            text += chunk.toString("utf8", offset);
                            break;
                        }
                        return text;
                    };

                    stream.on("data", (chunk) => {
                        const text = parseChunk(chunk);
                        if (text) {
                            const filtered = text.replace(/(\x1B\[[0-9;]*[JKmsu])?\[Server process ended\](\x1B\[[0-9;]*[JKmsu])?/g, "");
                            if (filtered) {
                                res.write(`data: ${JSON.stringify({ event: "output", data: filtered })}\n\n`);
                            }
                        }
                    });

                    stream.on("end", () => {
                        res.write(`data: ${JSON.stringify({ event: "ended" })}\n\n`);
                        res.end();
                    });

                    stream.on("error", (err) => {
                        res.write(`data: ${JSON.stringify({ event: "error", data: err.message })}\n\n`);
                        res.end();
                    });

                    // Clean up when client disconnects
                    req.on("close", () => {
                        stream.destroy();
                    });

                } catch (e) {
                    if (!res.headersSent) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: e.message }));
                    }
                }
                return;
            }

            // ── Console Input (POST) ─────────────
            const consoleInputMatch = pathname.match(/^\/api\/servers\/(.+)\/console\/input$/);
            if (consoleInputMatch && req.method === "POST") {
                const containerId = consoleInputMatch[1];
                try {
                    const body = await readBody(req);
                    const { command } = JSON.parse(body);

                    if (!command && command !== "") {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Missing 'command' field" }));
                        return;
                    }

                    // Check env type to decide how to send the command
                    const container = docker.getContainer(containerId);
                    const info = await container.inspect();
                    const envType = info.Config.Labels?.["ghosting.env_type"] || "minecraft";

                    if (envType === "minecraft") {
                        // If the command is 'stop', disable restart policy first
                        if (command.trim().toLowerCase() === "stop") {
                            await container.update({ RestartPolicy: { Name: "no" } });
                        }
                        // Minecraft: write to stdin (server reads commands from stdin)
                        const { writeToStdin } = await import("./console.js");
                        await writeToStdin(containerId, command);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        // Node.js, Python, Docker: use docker exec to run shell commands
                        const { execCommand } = await import("./docker.js");
                        const output = await execCommand(containerId, command);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true, output }));
                    }
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                }
                return;
            }

            // ── Delete container ────────────────
            // (Moved below backups/files to avoid collision)
            const deleteMatch = pathname.match(/^\/api\/servers\/(.+)$/);
            if (deleteMatch && req.method === "DELETE") {
                const dockerId = deleteMatch[1];
                try {
                    // Stop proxy before deleting container
                    try {
                        const container = docker.getContainer(dockerId);
                        const info = await container.inspect();
                        const sId = info.Config.Labels["ghosting.server_id"];
                        if (sId) stopProxy(sId);
                    } catch { }

                    await deleteServer(dockerId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Failed to delete container: " + e.message }));
                }
                return;
            }

            // ── 404 ────────────────────────────
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Not found" }));
        } catch (err) {
            console.error("[HTTP] Error:", err.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: err.message }));
        }
    });

    server.listen(config.httpPort, config.httpHost, () => {
        console.log(`[HTTP] Server listening on ${config.httpHost}:${config.httpPort}`);
    });

    return server;
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
    });
}
