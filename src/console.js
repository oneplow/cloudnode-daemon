import { streamLogs, writeToContainer } from "./docker.js";

/**
 * Active console sessions
 * Map<serverId, { listeners: Set<Function>, stream: Stream, buffer: Array, lastFlush: number }
 */
const activeSessions = new Map();

/**
 * Log buffering settings
 */
const LOG_BUFFER_SIZE = 100;
const LOG_FLUSH_INTERVAL = 500; // ms

/**
 * Flush buffered logs to listeners
 */
function flushLogs(session) {
    if (session.buffer.length === 0) return;
    
    const logs = [...session.buffer];
    session.buffer = [];
    session.lastFlush = Date.now();
    
    for (const listener of session.listeners) {
        try {
            for (const log of logs) {
                listener(log);
            }
        } catch { }
    }
}

/**
 * Attach console to a server container and stream output
 */
export function attachConsole(serverId, dockerId, onLine) {
    // If already streaming, just add the listener
    if (activeSessions.has(serverId)) {
        const session = activeSessions.get(serverId);
        session.listeners.add(onLine);
        return;
    }

    const session = {
        dockerId,
        listeners: new Set([onLine]),
        buffer: [],
        lastFlush: Date.now(),
    };

    // Start log stream with buffering
    streamLogs(dockerId, (line) => {
        session.buffer.push(line);
        
        // Flush if buffer is full or time interval passed
        if (session.buffer.length >= LOG_BUFFER_SIZE || 
            Date.now() - session.lastFlush >= LOG_FLUSH_INTERVAL) {
            flushLogs(session);
        }
    });

    // Set up periodic flush
    const flushInterval = setInterval(() => {
        if (activeSessions.has(serverId)) {
            flushLogs(session);
        } else {
            clearInterval(flushInterval);
        }
    }, LOG_FLUSH_INTERVAL);

    activeSessions.set(serverId, session);
    console.log(`[Console] Attached to server ${serverId} (buffered)`);
}

/**
 * Detach a listener from console
 */
export function detachConsole(serverId, onLine) {
    const session = activeSessions.get(serverId);
    if (!session) return;

    session.listeners.delete(onLine);
    
    // Flush remaining logs before removing session
    if (session.buffer.length > 0) {
        flushLogs(session);
    }

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
