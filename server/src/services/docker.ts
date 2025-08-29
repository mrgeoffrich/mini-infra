import Docker from "dockerode";
import NodeCache from "node-cache";
import logger from "../lib/logger";
import config from "../lib/config";
import { DockerContainerInfo } from "@mini-infra/types/containers";

class DockerService {
  private static instance: DockerService;
  private docker: Docker;
  private cache: NodeCache;
  private connected: boolean = false;
  private reconnectInterval: NodeJS.Timeout | null = null;

  private constructor() {
    // Initialize Docker client
    let dockerHost = config.DOCKER_HOST;
    
    // Default Docker host based on platform
    if (!dockerHost) {
      if (process.platform === "win32") {
        // Windows: Use named pipe for Docker Desktop
        dockerHost = "//./pipe/docker_engine";
      } else {
        // Unix/Linux/Mac: Use Unix socket
        dockerHost = "/var/run/docker.sock";
      }
    }
    
    let dockerConfig: any = {};

    // Parse Docker host configuration
    if (dockerHost.startsWith("npipe://")) {
      // Windows named pipe
      dockerConfig.socketPath = dockerHost;
    } else if (dockerHost.startsWith("unix://")) {
      // Unix socket with unix:// prefix
      dockerConfig.socketPath = dockerHost.replace("unix://", "");
    } else if (dockerHost.startsWith("tcp://") || dockerHost.startsWith("http://") || dockerHost.startsWith("https://")) {
      // TCP connection
      const url = new URL(dockerHost);
      dockerConfig.host = url.hostname;
      dockerConfig.port = parseInt(url.port || "2375");
      if (dockerHost.startsWith("https://")) {
        dockerConfig.protocol = "https";
      } else {
        dockerConfig.protocol = "http";
      }
    } else if (dockerHost.startsWith("/") || dockerHost.startsWith("\\") || dockerHost.includes("pipe")) {
      // Direct socket path (Windows named pipe or Unix socket)
      dockerConfig.socketPath = dockerHost;
    } else {
      // Assume it's a host:port format
      const parts = dockerHost.split(":");
      dockerConfig.host = parts[0];
      dockerConfig.port = parseInt(parts[1] || "2375");
      dockerConfig.protocol = "http";
    }

    // Add API version if specified
    if (config.DOCKER_API_VERSION) {
      dockerConfig.version = config.DOCKER_API_VERSION.startsWith("v") 
        ? config.DOCKER_API_VERSION 
        : `v${config.DOCKER_API_VERSION}`;
    }

    logger.info({
      dockerHost,
      dockerConfig
    }, "Initializing Docker client");

    this.docker = new Docker(dockerConfig);

    // Initialize cache with 3-second TTL
    this.cache = new NodeCache({
      stdTTL: Math.floor((config.CONTAINER_CACHE_TTL || 3000) / 1000),
      checkperiod: 5,
    });
  }

  public static getInstance(): DockerService {
    if (!DockerService.instance) {
      DockerService.instance = new DockerService();
    }
    return DockerService.instance;
  }

  public async initialize(): Promise<void> {
    logger.info("Initializing Docker connection at startup...");
    
    try {
      await this.connect(false); // Don't schedule reconnect during startup
      this.setupEventListeners();
      logger.info("Docker service initialized successfully");
    } catch (error) {
      logger.error({ 
        error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "Failed to initialize Docker connection at startup");
      throw new Error(`Docker initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async connect(shouldScheduleReconnect: boolean = true): Promise<void> {
    try {
      const pingResult = await this.docker.ping();
      this.connected = true;
      logger.info("Docker service connected successfully");

      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
    } catch (error) {
      this.connected = false;
      logger.error({
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, "Failed to connect to Docker");
      
      if (shouldScheduleReconnect) {
        this.scheduleReconnect();
      }
      
      throw error; // Re-throw for startup initialization
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;

    this.reconnectInterval = setInterval(async () => {
      logger.info("Attempting to reconnect to Docker...");
      try {
        await this.connect(true); // Allow scheduling reconnect in background
      } catch (error) {
        logger.error({ error }, "Reconnection attempt failed");
      }
    }, 10000); // Try every 10 seconds
  }

  private setupEventListeners(): void {
    // Subscribe to Docker events for cache invalidation
    this.docker.getEvents({}, (err, stream) => {
      if (err) {
        logger.error({ error: err }, "Failed to subscribe to Docker events");
        return;
      }

      if (stream) {
        stream.on("data", (data) => {
          try {
            const event = JSON.parse(data.toString());
            if (event.Type === "container") {
              logger.debug(
                {
                  action: event.Action,
                  containerId: event.id,
                },
                "Container event received, invalidating cache",
              );
              this.cache.flushAll();
            }
          } catch (error) {
            logger.error({ error }, "Failed to parse Docker event");
          }
        });

        stream.on("error", (error) => {
          logger.error({ error }, "Docker events stream error");
        });
      }
    });
  }

  public async listContainers(all = true): Promise<DockerContainerInfo[]> {
    if (!this.connected) {
      throw new Error("Docker service not connected");
    }

    const cacheKey = `containers_${all}`;
    const cached = this.cache.get<DockerContainerInfo[]>(cacheKey);

    if (cached) {
      logger.debug("Returning cached container list");
      return cached;
    }

    try {
      const containers = await Promise.race([
        this.docker.listContainers({ all }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Docker API timeout")), 5000),
        ),
      ]);

      const containerInfos = await Promise.all(
        containers.map((container) => this.transformContainerData(container)),
      );

      this.cache.set(cacheKey, containerInfos);
      logger.info(
        `Retrieved ${containerInfos.length} containers from Docker API`,
      );

      return containerInfos;
    } catch (error) {
      logger.error({ error }, "Failed to list containers");
      throw error;
    }
  }

  public async getContainer(id: string): Promise<DockerContainerInfo | null> {
    if (!this.connected) {
      throw new Error("Docker service not connected");
    }

    const cacheKey = `container_${id}`;
    const cached = this.cache.get<DockerContainerInfo>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const container = this.docker.getContainer(id);
      const data = await Promise.race([
        container.inspect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Docker API timeout")), 5000),
        ),
      ]);

      const containerInfo = this.transformDetailedContainerData(data);
      this.cache.set(cacheKey, containerInfo);

      return containerInfo;
    } catch (error) {
      if ((error as any).statusCode === 404) {
        return null;
      }
      logger.error(
        {
          error,
          containerId: id,
        },
        "Failed to get container details",
      );
      throw error;
    }
  }

  private transformContainerData(container: any): DockerContainerInfo {
    return {
      id: container.Id,
      name: container.Names[0]?.replace(/^\//, "") || "unknown",
      status: this.normalizeStatus(container.State),
      image: container.Image.split(":")[0] || "unknown",
      imageTag: container.Image.split(":")[1] || "latest",
      ports: this.transformPorts(container.Ports || []),
      volumes: this.transformVolumes(container.Mounts || []),
      ipAddress: this.extractIpAddress(container.NetworkSettings),
      createdAt: new Date(container.Created * 1000),
      startedAt: container.StartedAt
        ? new Date(container.StartedAt)
        : undefined,
      labels: this.sanitizeLabels(container.Labels || {}),
    };
  }

  private transformDetailedContainerData(data: any): DockerContainerInfo {
    return {
      id: data.Id,
      name: data.Name?.replace(/^\//, "") || "unknown",
      status: this.normalizeStatus(data.State.Status),
      image: data.Config.Image.split(":")[0] || "unknown",
      imageTag: data.Config.Image.split(":")[1] || "latest",
      ports: this.transformDetailedPorts(data.NetworkSettings?.Ports || {}),
      volumes: this.transformVolumes(data.Mounts || []),
      ipAddress:
        data.NetworkSettings?.IPAddress ||
        data.NetworkSettings?.Networks?.bridge?.IPAddress,
      createdAt: new Date(data.Created),
      startedAt: data.State.StartedAt
        ? new Date(data.State.StartedAt)
        : undefined,
      labels: this.sanitizeLabels(data.Config.Labels || {}),
    };
  }

  private normalizeStatus(status: string): DockerContainerInfo["status"] {
    const lowercaseStatus = status.toLowerCase();
    switch (lowercaseStatus) {
      case "running":
        return "running";
      case "exited":
        return "exited";
      case "stopped":
        return "stopped";
      case "restarting":
        return "restarting";
      case "paused":
        return "paused";
      default:
        return "exited";
    }
  }

  private transformPorts(ports: any[]): DockerContainerInfo["ports"] {
    return ports.map((port) => ({
      private: port.PrivatePort,
      public: port.PublicPort || undefined,
      type: port.Type === "tcp" ? "tcp" : "udp",
    }));
  }

  private transformDetailedPorts(ports: any): DockerContainerInfo["ports"] {
    const result: DockerContainerInfo["ports"] = [];

    for (const [privatePort, bindings] of Object.entries(ports)) {
      const [port, protocol] = privatePort.split("/");
      const portInfo = {
        private: parseInt(port),
        type: protocol === "tcp" ? ("tcp" as const) : ("udp" as const),
        public: undefined as number | undefined,
      };

      if (Array.isArray(bindings) && bindings.length > 0) {
        portInfo.public = parseInt(bindings[0].HostPort);
      }

      result.push(portInfo);
    }

    return result;
  }

  private transformVolumes(mounts: any[]): DockerContainerInfo["volumes"] {
    return mounts.map((mount) => ({
      source: mount.Source || mount.Name,
      destination: mount.Destination,
      mode: mount.RW ? "rw" : "ro",
    }));
  }

  private extractIpAddress(networkSettings: any): string | undefined {
    if (!networkSettings) return undefined;

    if (networkSettings.IPAddress) {
      return networkSettings.IPAddress;
    }

    const networks = networkSettings.Networks;
    if (networks) {
      for (const network of Object.values(networks) as any[]) {
        if (network.IPAddress) {
          return network.IPAddress;
        }
      }
    }

    return undefined;
  }

  private sanitizeLabels(
    labels: Record<string, string>,
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveKeys = [
      "password",
      "secret",
      "token",
      "key",
      "auth",
      "credential",
      "api_key",
      "private",
      "confidential",
    ];

    for (const [key, value] of Object.entries(labels)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveKeys.some((sensitive) =>
        lowerKey.includes(sensitive),
      );

      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getCacheStats() {
    return {
      keys: this.cache.keys().length,
      stats: this.cache.getStats(),
    };
  }

  public flushCache(): void {
    this.cache.flushAll();
    logger.info("Docker service cache flushed");
  }
}

export default DockerService;
