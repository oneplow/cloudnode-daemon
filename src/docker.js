import Docker from "dockerode";
import config from "./config.js";

const docker = new Docker({ socketPath: config.dockerSocket });

import fs from "fs/promises";

const NETWORK_NAME = "ghosting-net";

/**
 * Ensure the ghosting-net Docker network exists
 */
export async function ensureNetwork() {
    try {
        const network = docker.getNetwork(NETWORK_NAME);
        await network.inspect();
        console.log(`[Docker] Network '${NETWORK_NAME}' already exists.`);
    } catch {
        console.log(`[Docker] Creating network '${NETWORK_NAME}'...`);
        await docker.createNetwork({
            Name: NETWORK_NAME,
            Driver: "bridge",
            CheckDuplicate: true,
        });
        console.log(`[Docker] Network '${NETWORK_NAME}' created.`);
    }
}

/**
 * Get the container's IP address on the ghosting-net network
 */
export async function getContainerIP(dockerId) {
    const container = docker.getContainer(dockerId);
    const info = await container.inspect();
    const networks = info.NetworkSettings.Networks;

    // Try ghosting-net first
    if (networks[NETWORK_NAME]) {
        return networks[NETWORK_NAME].IPAddress;
    }

    // Fallback: return any available IP
    for (const net of Object.values(networks)) {
        if (net.IPAddress) return net.IPAddress;
    }

    throw new Error(`Container ${dockerId} has no IP address`);
}

/**
 * Pull a Docker image only if missing (with timeout + validation)
 */
export async function pullImage(image) {
    // Validate image name — must look like "name:tag" or "registry/name:tag"
    if (!image || !/^[a-z0-9._/-]+(?::[a-z0-9._-]+)?$/i.test(image)) {
        throw new Error(`Invalid Docker image name: "${image}"`);
    }

    try {
        const imageInfo = await docker.getImage(image).inspect();
        if (imageInfo) {
            console.log(`[Docker] Image ${image} already exists locally. Skipping pull.`);
            return;
        }
    } catch (e) {
        // Image not found locally, proceed to pull
    }

    console.log(`[Docker] Pulling image: ${image}`);

    const PULL_TIMEOUT = 2 * 60 * 1000; // 2 minutes

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Image pull timed out after 2 minutes: ${image}`));
        }, PULL_TIMEOUT);

        docker.pull(image, (err, stream) => {
            if (err) {
                clearTimeout(timeout);
                return reject(new Error(`Failed to pull image "${image}": ${err.message}`));
            }
            docker.modem.followProgress(stream, (err) => {
                clearTimeout(timeout);
                if (err) return reject(new Error(`Failed to pull image "${image}": ${err.message}`));
                console.log(`[Docker] Image pulled: ${image}`);
                resolve();
            });
        });
    });
}

/**
 * Create and start a container for any environment type
 * If an egg with installScript is provided, runs the install step first.
 */
export async function createServer({ serverId, image, env, limits, ports, envType, cmd, egg }) {
    const containerName = `${config.containerPrefix}${serverId.substring(0, 12)}`;
    const dataPath = `${config.dataDir}/${serverId}`;

    // Ensure directory exists with proper permissions
    await fs.mkdir(dataPath, { recursive: true }).catch(() => { });

    // Ensure the internal Docker network exists
    await ensureNetwork();

    // Determine if this is a Pterodactyl yolks image
    const isYolksImage = image && image.includes("pterodactyl/yolks");
    // Yolks images use /home/container, standard images use /data
    const containerDataPath = isYolksImage ? "/home/container" : "/data";

    // ── Egg Installation Step ──────────────────────────────
    if (egg?.installScript) {
        console.log(`[Docker] Running egg installation script for ${serverId}...`);
        const installerImage = egg.installContainer || "ghcr.io/pterodactyl/installers:alpine";
        const entrypoint = egg.installEntrypoint || "ash";

        await pullImage(installerImage);

        // Build env array from egg variables
        const installEnv = Object.entries(egg.variables || {}).map(([k, v]) => `${k}=${v}`);

        // Create installer container
        const installer = await docker.createContainer({
            name: `install-${serverId.substring(0, 12)}`,
            Image: installerImage,
            Env: installEnv,
            Tty: true,
            OpenStdin: true,
            Cmd: [entrypoint, "-c", egg.installScript],
            HostConfig: {
                Binds: [`${dataPath}:/mnt/server`],
            },
        });

        await installer.start();
        console.log(`[Docker] Installer started for ${serverId}`);

        // Stream install logs
        try {
            const stream = await installer.logs({ follow: true, stdout: true, stderr: true });
            stream.on("data", (chunk) => {
                const line = chunk.toString().replace(/[\x00-\x08]/g, "").trim();
                if (line) console.log(`[Install:${serverId.substring(0, 8)}] ${line}`);
            });
        } catch { }

        // Wait for installer to finish
        await installer.wait();
        console.log(`[Docker] Installation completed for ${serverId}`);

        // Cleanup installer container
        await installer.remove({ force: true }).catch(() => { });

        // Fix file permissions — yolks images run as UID 1000 (container user)
        if (isYolksImage) {
            console.log(`[Docker] Fixing file permissions for ${serverId}...`);
            const fixer = await docker.createContainer({
                name: `fix-perms-${serverId.substring(0, 12)}`,
                Image: "alpine:latest",
                Cmd: ["sh", "-c", "chown -R 1000:1000 /mnt/server && chmod -R 755 /mnt/server"],
                HostConfig: {
                    Binds: [`${dataPath}:/mnt/server`],
                },
            });
            await fixer.start();
            await fixer.wait();
            await fixer.remove({ force: true }).catch(() => { });
            console.log(`[Docker] Permissions fixed for ${serverId}`);
        }
    }

    // ── Pull main server image ─────────────────────────────
    await pullImage(image);

    // Build env array
    const envArray = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);

    // If we have egg variables, add them to the server env too
    if (egg?.variables) {
        Object.entries(egg.variables).forEach(([k, v]) => {
            envArray.push(`${k}=${v}`);
        });
    }

    // If we have an egg startup command, resolve {{VARIABLE}} templates and set STARTUP env
    if (egg?.startup) {
        let startupCmd = egg.startup;
        // Replace {{VAR_NAME}} with actual values from egg variables
        if (egg.variables) {
            Object.entries(egg.variables).forEach(([k, v]) => {
                startupCmd = startupCmd.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
            });
        }
        envArray.push(`STARTUP=${startupCmd}`);
    }

    // Expose ports inside container (for documentation), but NO host port bindings
    const exposedPorts = {};
    if (ports && ports.length > 0) {
        ports.forEach((p) => {
            exposedPorts[`${p.container}/${p.protocol || "tcp"}`] = {};
        });
    }

    const containerOptions = {
        name: containerName,
        Image: image,
        Env: envArray,
        ExposedPorts: exposedPorts,
        Tty: true,
        OpenStdin: true,
        // Run as root for yolks images to avoid permission issues with bind mounts
        User: isYolksImage ? "0" : undefined,
        HostConfig: {
            Memory: (limits?.memory || 1024) * 1024 * 1024, // MB → bytes
            NanoCpus: Math.floor((limits?.cpu || 100) * 1e7), // % → nanocpus
            DiskQuota: (limits?.disk || 10240) * 1024 * 1024, // MB → bytes
            Binds: [`${dataPath}:${containerDataPath}`],
            // No PortBindings — container ports are NOT exposed on host
            // Traffic goes through TCP proxy instead (proxy.js)
            RestartPolicy: { Name: "unless-stopped" },
            NetworkMode: NETWORK_NAME,
        },
        Labels: {
            "ghosting.server_id": serverId,
            "ghosting.managed": "true",
            "ghosting.env_type": envType || "generic",
        },
    };

    // Add startup command if provided (for non-egg containers like Node.js)
    if (cmd && Array.isArray(cmd) && cmd.length > 0) {
        containerOptions.Cmd = cmd;
    }

    const container = await docker.createContainer(containerOptions);

    await container.start();
    console.log(`[Docker] Container started: ${containerName} (${container.id})`);

    // Get the container's internal IP on ghosting-net
    const containerIp = await getContainerIP(container.id);
    console.log(`[Docker] Container IP: ${containerIp}`);

    return {
        containerId: container.id,
        containerName,
        containerIp,
    };
}

/**
 * Upgrade container resource limits dynamically (no restart)
 */
export async function upgradeServer(dockerId, limits) {
    const container = docker.getContainer(dockerId);

    const memBytes = (limits?.memory || 1024) * 1024 * 1024;

    const updateOptions = {
        Memory: memBytes,
        MemorySwap: memBytes,       // Must equal Memory to avoid Docker auto-kill
        NanoCpus: Math.floor((limits?.cpu || 100) * 1e7),
        RestartPolicy: { Name: "unless-stopped" },
    };

    await container.update(updateOptions);
    console.log(`[Docker] Container limits updated (no restart): ${dockerId}`);
}

/**
 * Power control: start, stop, restart, kill
 */
export async function powerAction(dockerId, action) {
    const container = docker.getContainer(dockerId);

    switch (action) {
        case "start":
            // Restore restart policy on start
            await container.update({ RestartPolicy: { Name: "unless-stopped" } });
            await container.start();
            break;
        case "stop": {
            // Disable restart policy BEFORE stopping so Docker doesn't auto-restart
            await container.update({ RestartPolicy: { Name: "no" } });

            // Try graceful stop based on environment type
            try {
                const info = await container.inspect();
                const envType = info.Config.Labels["ghosting.env_type"] || "generic";
                const stopCmd = getGracefulStopCommand(envType);
                if (stopCmd) {
                    await writeToContainer(dockerId, stopCmd);
                }
            } catch (err) {
                console.warn("[Docker] Failed to send graceful stop command:", err.message);
            }
            await container.stop({ t: 20 });
            break;
        }
        case "restart": {
            // Keep restart policy as-is for restart
            try {
                const info = await container.inspect();
                const envType = info.Config.Labels["ghosting.env_type"] || "generic";
                const stopCmd = getGracefulStopCommand(envType);
                if (stopCmd) {
                    await writeToContainer(dockerId, stopCmd);
                }
            } catch (err) {
                console.warn("[Docker] Failed to send graceful stop command for restart:", err.message);
            }
            await container.restart({ t: 20 });
            break;
        }
        case "kill":
            // Disable restart policy before kill
            await container.update({ RestartPolicy: { Name: "no" } }).catch(() => { });
            try {
                await container.kill();
            } catch (err) {
                if (err.statusCode === 409) {
                    console.log(`[Docker] Kill skipped: Container ${dockerId} is not running`);
                } else {
                    throw err;
                }
            }
            break;
        default:
            throw new Error(`Unknown power action: ${action}`);
    }

    console.log(`[Docker] Power ${action} executed`);
}

/**
 * Get the appropriate graceful shutdown command for each environment type
 */
function getGracefulStopCommand(envType) {
    switch (envType) {
        case "minecraft":
            return "stop";
        case "node":
        default:
            return null;
    }
}

/**
 * Delete a container and its data
 */
export async function deleteServer(dockerId) {
    const container = docker.getContainer(dockerId);
    let serverId = null;

    try {
        const info = await container.inspect();
        serverId = info.Config.Labels["ghosting.server_id"];
        await container.stop({ t: 5 }).catch(() => { });
    } catch { }

    try {
        await container.remove({ force: true, v: true });
        console.log(`[Docker] Container removed: ${dockerId}`);
    } catch (e) {
        console.error(`[Docker] Failed to remove container ${dockerId}:`, e.message);
    }

    if (serverId) {
        const dataPath = `${config.dataDir}/${serverId}`;
        try {
            await fs.rm(dataPath, { recursive: true, force: true });
            console.log(`[Docker] Data directory removed: ${dataPath}`);
        } catch (e) {
            console.error(`[Docker] Failed to remove data directory ${dataPath}:`, e.message);
        }
    }
}

/**
 * Write a command directly to a container's stdin (for game server commands)
 */
export async function writeToContainer(dockerId, command) {
    const container = docker.getContainer(dockerId);
    const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: false,
        stderr: false,
    });

    // Most game servers expect a newline at the end of the command
    stream.write(command + "\n");
}

/**
 * Execute a command inside a container via docker exec (for OS/app containers)
 * Returns the command output as a string
 */
export async function execCommand(dockerId, command) {
    const container = docker.getContainer(dockerId);

    const exec = await container.exec({
        Cmd: ["/bin/sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
    });

    return new Promise((resolve, reject) => {
        exec.start({ hijack: true, stdin: false }, (err, stream) => {
            if (err) return reject(err);

            const chunks = [];
            stream.on("data", (chunk) => {
                chunks.push(chunk);
            });
            stream.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                // Strip Docker stream multiplexing headers + control chars
                const clean = raw
                    .replace(/[\x00-\x08\x0e-\x1f]/g, "")  // control chars (keep \n \r \t)
                    .replace(/\r\n/g, "\n")
                    .trim();
                resolve(clean);
            });
            stream.on("error", reject);

            // Timeout after 30 seconds
            setTimeout(() => {
                stream.destroy();
                const raw = Buffer.concat(chunks).toString("utf8");
                const clean = raw.replace(/[\x00-\x08\x0e-\x1f]/g, "").replace(/\r\n/g, "\n").trim();
                resolve(clean || "(command timed out)");
            }, 30000);
        });
    });
}

/**
 * Get container stats (CPU, memory, network)
 */
export async function getContainerStats(dockerId) {
    const container = docker.getContainer(dockerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = sysDelta > 0
        ? (cpuDelta / sysDelta) * (stats.cpu_stats.online_cpus || 1) * 100
        : 0;

    const memUsed = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;

    const info = await container.inspect();
    const serverId = info.Config.Labels["ghosting.server_id"];

    // Add missing files import if not present
    const { getDirectorySize } = await import("./files.js");
    const diskBytes = serverId ? await getDirectorySize(`${config.dataDir}/${serverId}`) : 0;

    return {
        cpu: Math.round(cpuPercent * 100) / 100,
        memory: Math.round(memUsed / 1024 / 1024), // MB
        memoryLimit: Math.round(memLimit / 1024 / 1024), // MB
        memoryPercent: memLimit > 0 ? Math.round((memUsed / memLimit) * 10000) / 100 : 0,
        disk: Math.round(diskBytes / 1024 / 1024), // Add this in MB
        network: {
            rx: Object.values(stats.networks || {}).reduce((a, n) => a + n.rx_bytes, 0),
            tx: Object.values(stats.networks || {}).reduce((a, n) => a + n.tx_bytes, 0),
        },
    };
}

/**
 * List all managed containers
 */
export async function listManagedContainers() {
    const containers = await docker.listContainers({
        all: true,
        filters: { label: ["ghosting.managed=true"] },
    });
    return containers;
}

/**
 * Stream container logs (follow mode)
 */
export function streamLogs(dockerId, onLine, options = {}) {
    const container = docker.getContainer(dockerId);
    const tail = options.tail || 200;

    container.logs(
        { follow: true, stdout: true, stderr: true, tail },
        (err, stream) => {
            if (err) {
                console.error(`[Docker] Log stream error for ${dockerId}:`, err);
                return;
            }

            stream.on("data", (chunk) => {
                // If TTY is false, Docker prepends an 8-byte multiplex header [type(1), 0,0,0, size(4)].
                // We must properly parse it instead of blindly dropping 8 bytes.
                let offset = 0;
                let text = "";

                // Read through the chunk buffer
                while (offset < chunk.length) {
                    // Check if this looks like a Docker multiplex header:
                    // type is 1 (stdout) or 2 (stderr), next 3 bytes are 0
                    if (chunk.length - offset >= 8 &&
                        (chunk[offset] === 1 || chunk[offset] === 2) &&
                        chunk[offset + 1] === 0 &&
                        chunk[offset + 2] === 0 &&
                        chunk[offset + 3] === 0) {

                        // Read the size (bytes 4-7, big-endian)
                        const size = chunk.readUInt32BE(offset + 4);
                        if (size > 0 && offset + 8 + size <= chunk.length) {
                            text += chunk.toString("utf8", offset + 8, offset + 8 + size);
                            offset += 8 + size;
                            continue;
                        }
                    }

                    // If it doesn't match the header signature or is TTY mode,
                    // just process the rest of the chunk as raw UTF-8.
                    text += chunk.toString("utf8", offset);
                    break;
                }

                if (text.trim()) {
                    onLine(text); // Preserve internal whitespace, just drop empty lines
                }
            });

            stream.on("error", () => { });
            stream.on("end", () => { });
        }
    );
}

export { docker };
export default docker;
