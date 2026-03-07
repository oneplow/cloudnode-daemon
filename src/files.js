import fs from "fs/promises";
import path from "path";
import config from "./config.js";



/**
 * Recursively get the size of a directory in bytes.
 */
export async function getDirectorySize(dirPath) {
    try {
        const stats = await fs.stat(dirPath);
        if (stats.isFile()) return stats.size;
        if (!stats.isDirectory()) return 0;

        const files = await fs.readdir(dirPath);
        const sizes = await Promise.all(
            files.map((file) => getDirectorySize(path.join(dirPath, file)))
        );
        return sizes.reduce((acc, size) => acc + size, 0);
    } catch {
        return 0; // Return 0 if directory doesn't exist or is inaccessible
    }
}

/**
 * Get the absolute, safe path for a file inside a server's data directory.
 * Prevents directory traversal attacks.
 */
export function getSafePath(serverId, reqPath) {
    const baseDir = path.resolve(config.dataDir, serverId);
    // Remove leading slashes so path.join treats it as relative
    const cleanReqPath = (reqPath || "/").replace(/^[\\/]+/, "");
    const targetPath = path.resolve(baseDir, cleanReqPath);

    if (!targetPath.startsWith(baseDir)) {
        throw new Error("Invalid path");
    }

    return { targetPath, baseDir };
}

export async function listFiles(serverId, reqPath = "/") {
    const { targetPath } = getSafePath(serverId, reqPath);

    try {
        const stats = await fs.stat(targetPath);
        if (!stats.isDirectory()) {
            throw new Error("Target is not a directory");
        }

        const items = await fs.readdir(targetPath, { withFileTypes: true });

        const filesInfo = await Promise.all(
            items.map(async (item) => {
                const itemPath = path.join(targetPath, item.name);
                try {
                    const itemStats = await fs.stat(itemPath);
                    return {
                        name: item.name,
                        type: item.isDirectory() ? "directory" : "file",
                        size: item.isDirectory() ? null : itemStats.size,
                        modified: itemStats.mtime.toISOString(),
                    };
                } catch {
                    return null;
                }
            })
        );

        // Filter out any errors and sort (dirs first, then files alphabetically)
        return filesInfo
            .filter(Boolean)
            .sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === "directory" ? -1 : 1;
            });
    } catch (error) {
        if (error.code === "ENOENT") return []; // Empty/non-existent yet
        throw error;
    }
}

export async function readFile(serverId, reqPath) {
    const { targetPath } = getSafePath(serverId, reqPath);
    return fs.readFile(targetPath, "utf-8");
}

export async function writeFile(serverId, reqPath, content) {
    const { targetPath } = getSafePath(serverId, reqPath);
    await fs.writeFile(targetPath, content, "utf-8");
}

export async function createFileOrDir(serverId, reqPath, isDir = false) {
    const { targetPath } = getSafePath(serverId, reqPath);
    if (isDir) {
        await fs.mkdir(targetPath, { recursive: true });
    } else {
        await fs.writeFile(targetPath, "", "utf-8");
    }
}

export async function deleteFileOrDir(serverId, reqPath) {
    const { targetPath, baseDir } = getSafePath(serverId, reqPath);
    if (targetPath === baseDir) {
        throw new Error("Cannot delete root directory");
    }
    await fs.rm(targetPath, { recursive: true, force: true });
}
