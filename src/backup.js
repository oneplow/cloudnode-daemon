import fs from "fs/promises";
import path from "path";
import config from "./config.js";
import * as tar from "tar";

export async function createBackup(serverId, backupName) {
    const dataDir = path.resolve(config.dataDir, serverId);
    const backupDir = path.resolve(config.dataDir, "../backups", serverId);

    // Ensure backup directory exists
    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${backupName || "backup"}-${timestamp}.tar.gz`;
    const backupPath = path.resolve(backupDir, filename);

    // Ensure data directory exists and has files
    try {
        const items = await fs.readdir(dataDir);
        console.log(`[Backup] Starting backup for ${serverId}. Files to pack: ${items.length}`);
        if (items.length === 0) {
            console.warn(`[Backup] Warning: Data directory is empty for ${serverId}`);
        }
    } catch (e) {
        console.error(`[Backup] Data directory not found: ${dataDir}`);
        throw new Error("Server data directory is missing. Please start the server at least once.");
    }

    // Create tarball and ensure it's fully written
    await new Promise((resolve, reject) => {
        tar.c(
            {
                gzip: true,
                file: backupPath,
                cwd: dataDir,
            },
            ["."]
        ).then(resolve).catch(reject);
    });

    const stats = await fs.stat(backupPath);
    console.log(`[Backup] Completed: ${filename} (${stats.size} bytes)`);
    return { name: filename, size: stats.size, createdAt: stats.birthtime };
}

export async function listBackups(serverId) {
    const backupDir = path.resolve(config.dataDir, "../backups", serverId);
    try {
        await fs.access(backupDir);
    } catch {
        return [];
    }

    const items = await fs.readdir(backupDir, { withFileTypes: true });
    const backups = items
        .filter(item => item.isFile() && item.name.endsWith(".tar.gz"))
        .map(async item => {
            const stats = await fs.stat(path.resolve(backupDir, item.name));
            return {
                name: item.name,
                size: stats.size,
                createdAt: stats.birthtime
            };
        });

    return Promise.all(backups);
}

export async function deleteBackup(serverId, filename) {
    const backupDir = path.resolve(config.dataDir, "../backups", serverId);
    const backupPath = path.resolve(backupDir, filename);

    // Safety check
    if (!backupPath.startsWith(backupDir)) throw new Error("Invalid backup path");

    await fs.unlink(backupPath);
}

export async function restoreBackup(serverId, filename) {
    const dataDir = path.resolve(config.dataDir, serverId);
    const backupDir = path.resolve(config.dataDir, "../backups", serverId);
    const backupPath = path.resolve(backupDir, filename);

    if (!backupPath.startsWith(backupDir)) throw new Error("Invalid backup path");

    await tar.x({
        file: backupPath,
        cwd: dataDir,
    });
}
