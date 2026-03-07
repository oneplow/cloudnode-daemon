import "dotenv/config";

const config = {
    // Daemon identity
    daemonId: process.env.DAEMON_ID || "daemon-01",
    nodeName: process.env.NODE_NAME || "SG-1",

    // API connection
    authToken: process.env.DAEMON_AUTH_TOKEN || "ghd_dev_token",

    // HTTP server
    httpPort: parseInt(process.env.DAEMON_PORT || "8443"),
    httpHost: process.env.DAEMON_HOST || "0.0.0.0",

    // Docker
    dockerSocket: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
    dataDir: process.env.DATA_DIR || "/opt/ghosting/data",
    containerPrefix: process.env.CONTAINER_PREFIX || "gs-",

    // FRP
    frpEnabled: process.env.FRP_ENABLED === "true",
    frpServerAddr: process.env.FRP_SERVER_ADDR || "0.0.0.0",
    frpServerPort: parseInt(process.env.FRP_SERVER_PORT || "7000"),
    frpToken: process.env.FRP_TOKEN || "",
};

export default config;
