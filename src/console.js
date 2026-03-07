import { streamLogs, writeToContainer } from "./docker.js";

/**
 * Active console sessions
 * Map<serverId, { listeners: Set<Function>, stream: Stream }>
 */
const activeSessions = new Map();

/**
 * Attach console to a server container and stream output
 */
export function attachConsole(serverId, dockerId, onLine) {
    // If already streaming, just add the listener
    if (activeSessions.has(serverId)) {
        activeSessions.get(serverId).listeners.add(onLine);
        return;
    }

    const session = {
        dockerId,
        listeners: new Set([onLine]),
    };

    // Start log stream
    streamLogs(dockerId, (line) => {
        for (const listener of session.listeners) {
            try {
                listener(line);
            } catch { }
        }
    });

    activeSessions.set(serverId, session);
    console.log(`[Console] Attached to server ${serverId}`);
}

/**
 * Detach a listener from console
 */
export function detachConsole(serverId, onLine) {
    const session = activeSessions.get(serverId);
    if (!session) return;

    session.listeners.delete(onLine);

    if (session.listeners.size === 0) {
        activeSessions.delete(serverId);
        console.log(`[Console] Detached from server ${serverId}`);
    }
}

/**
 * Send a command to a server container
 */
export async function sendCommand(serverId, dockerId, command) {
    console.log(`[Console] Command on ${serverId}: ${command}`);

    try {
        await writeToContainer(dockerId, command);
        return { success: true };
    } catch (e) {
        console.error(`[Console] Error:`, e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Write directly to container stdin (for interactive processes)
 */
export async function writeToStdin(dockerId, input) {
    // For servers that read from stdin (e.g. Minecraft, custom apps)
    // Use docker attach instead of exec
    const { docker } = await import("./docker.js");
    const container = docker.getContainer(dockerId);

    try {
        const stream = await container.attach({
            stream: true,
            stdin: true,
            hijack: true,
        });

        stream.write(input + "\n");
        stream.end();

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Get the count of active console sessions
 */
export function getActiveSessionCount() {
    return activeSessions.size;
}
