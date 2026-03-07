import si from "systeminformation";
import { listManagedContainers, getContainerStats } from "./docker.js";
import config from "./config.js";

/**
 * Collect node-level system metrics
 */
export async function getNodeMetrics() {
    const [mem, cpu, disk, load, net, fsSize] = await Promise.all([
        si.mem(),
        si.currentLoad(),
        si.disksIO().catch(() => ({})),
        si.fullLoad().catch(() => 0),
        si.networkStats().catch(() => []),
        si.fsSize().catch(() => []),
    ]);

    return {
        daemonId: config.daemonId,
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: {
            total: Math.round(mem.total / 1024 / 1024),    // MB
            used: Math.round(mem.used / 1024 / 1024),
            free: Math.round(mem.free / 1024 / 1024),
            available: Math.round(mem.available / 1024 / 1024),
            percent: Math.round((mem.used / mem.total) * 100),
        },
        cpu: {
            usage: Math.round(cpu.currentLoad * 100) / 100,
            cores: cpu.cpus?.length || 1,
            model: cpu.cpus?.[0]?.model || "Unknown",
            perCore: cpu.cpus?.map((c) => Math.round(c.load * 100) / 100) || [],
        },
        disk: {
            total: Math.round(fsSize.reduce((acc, fs) => acc + (fs.size || 0), 0) / 1024 / 1024),
            used: Math.round(fsSize.reduce((acc, fs) => acc + (fs.used || 0), 0) / 1024 / 1024),
            percent: fsSize.length ? Math.round((fsSize.reduce((acc, fs) => acc + (fs.used || 0), 0) / (fsSize.reduce((acc, fs) => acc + (fs.size || 0), 0) || 1)) * 100) : 0,
        },
        network: {
            interfaces: net.map((n) => ({
                name: n.iface,
                rx: n.rx_bytes,
                tx: n.tx_bytes,
                rxSec: n.rx_sec,
                txSec: n.tx_sec,
            })),
        },
        load: Math.round(load * 100) / 100,
    };
}

/**
 * Collect metrics for all managed game server containers
 */
export async function getServerMetrics() {
    const containers = await listManagedContainers();
    const metrics = [];

    for (const info of containers) {
        try {
            const serverId = info.Labels?.["ghosting.server_id"] || "";
            const stats = await getContainerStats(info.Id);

            metrics.push({
                serverId,
                containerId: info.Id,
                containerName: info.Names[0]?.replace("/", ""),
                state: info.State,
                status: info.Status,
                ...stats,
            });
        } catch (err) {
            // Container may have been removed
        }
    }

    return metrics;
}


