import Docker from "dockerode";
import NodeCache from "node-cache";
import { servicesLogger } from "../lib/logger-factory";
import { dockerConfig } from "../lib/config-new";
import { DockerContainerInfo } from "@mini-infra/types/containers";
import { DockerConfigService } from "./docker-config";
import prisma from "../lib/prisma";

class DockerService {
  private static instance: DockerService;
  private docker: Docker;
  private cache: NodeCache;
  private connected: boolean = false;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private dockerConfigService: DockerConfigService;

  private constructor() {
    // Initialize cache with 3-second TTL
    this.cache = new NodeCache({
      stdTTL: Math.floor(dockerConfig.containerCacheTtl / 1000),
      checkperiod: 5,
    });

    // Initialize Docker client - this will be done asynchronously in initialize()
    this.docker = {} as Docker; // Placeholder, will be set in initialize()
    
    // Initialize Docker configuration service - will be done in initialize()
    this.dockerConfigService = {} as DockerConfigService; // Placeholder
  }

  public static getInstance(): DockerService {
    if (!DockerService.instance) {
      DockerService.instance = new DockerService();
    }
    return DockerService.instance;
  }

  public async initialize(): Promise<void> {
    servicesLogger().info("Initializing Docker connection at startup...");

    try {
      // Initialize Docker configuration service first
      this.dockerConfigService = new DockerConfigService(prisma);
      
      // Create Docker client based on settings
      await this.createDockerClientFromSettings();

      // Attempt to connect
      await this.connect(false); // Don't schedule reconnect during startup
      this.setupEventListeners();
      servicesLogger().info("Docker service initialized successfully");
    } catch (error) {
      servicesLogger().warn(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to initialize Docker connection at startup - continuing with degraded functionality",
      );

      // Record connection failure in database instead of crashing
      try {
        if (this.dockerConfigService && typeof this.dockerConfigService.recordConnectivityStatus === 'function') {
          await this.dockerConfigService.recordConnectivityStatus(
            "failed",
            undefined,
            error instanceof Error ? error.message : String(error),
            this.getDockerErrorCode(error),
          );
        }
      } catch (dbError) {
        servicesLogger().error(
          { error: dbError },
          "Failed to record Docker connectivity failure in database",
        );
      }

      // Don't throw error - allow server to start with degraded Docker functionality
      servicesLogger().info(
        "Docker service initialized with degraded functionality - will retry connection attempts",
      );

      // Schedule reconnection attempts
      this.scheduleReconnect();
    }
  }

  /**
   * Create Docker client from database settings with fallback to environment variables
   */
  private async createDockerClientFromSettings(): Promise<void> {
    try {
      // Ensure dockerConfigService is initialized
      if (!this.dockerConfigService || typeof this.dockerConfigService.get !== 'function') {
        throw new Error("Docker configuration service not initialized");
      }
      
      // Try to get settings from database first
      const dockerHost = await this.dockerConfigService.get("host");
      const apiVersion = await this.dockerConfigService.get("apiVersion");

      let finalHost: string;
      let finalApiVersion: string | undefined;

      if (dockerHost) {
        finalHost = dockerHost;
        servicesLogger().info(
          { host: dockerHost },
          "Using Docker host from database settings",
        );
      } else {
        servicesLogger().warn("Docker host not configured in database settings - Docker functionality will be unavailable");
        throw new Error("Docker host not configured in database settings");
      }

      if (apiVersion) {
        finalApiVersion = apiVersion;
        servicesLogger().info(
          { apiVersion },
          "Using Docker API version from database settings",
        );
      } else {
        servicesLogger().info(
          "No Docker API version specified, using Docker daemon default",
        );
      }

      // Create Docker client using the same logic as DockerConfigService
      this.docker = this.createDockerClient(finalHost, finalApiVersion);

      servicesLogger().info("Docker client created successfully");
    } catch (error) {
      servicesLogger().error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to create Docker client from settings",
      );
      throw error;
    }
  }

  private async connect(
    shouldScheduleReconnect: boolean = true,
  ): Promise<void> {
    try {
      if (!this.docker || typeof this.docker.ping !== "function") {
        throw new Error("Docker client not initialized");
      }

      const startTime = Date.now();
      const pingResult = await this.docker.ping();
      const responseTimeMs = Date.now() - startTime;

      this.connected = true;
      servicesLogger().info(
        { responseTimeMs },
        "Docker service connected successfully",
      );

      // Record successful connection
      try {
        if (this.dockerConfigService && typeof this.dockerConfigService.recordConnectivityStatus === 'function') {
          await this.dockerConfigService.recordConnectivityStatus(
            "connected",
            responseTimeMs,
          );
        }
      } catch (dbError) {
        servicesLogger().error(
          { error: dbError },
          "Failed to record successful Docker connectivity in database",
        );
      }

      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
    } catch (error) {
      this.connected = false;
      const responseTimeMs = Date.now();

      servicesLogger().error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to connect to Docker",
      );

      // Record failed connection
      try {
        if (this.dockerConfigService && typeof this.dockerConfigService.recordConnectivityStatus === 'function') {
          await this.dockerConfigService.recordConnectivityStatus(
            "failed",
            responseTimeMs,
            error instanceof Error ? error.message : String(error),
            this.getDockerErrorCode(error),
          );
        }
      } catch (dbError) {
        servicesLogger().error(
          { error: dbError },
          "Failed to record Docker connectivity failure in database",
        );
      }

      if (shouldScheduleReconnect) {
        this.scheduleReconnect();
      }

      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;

    this.reconnectInterval = setInterval(async () => {
      servicesLogger().info("Attempting to reconnect to Docker...");
      try {
        // Ensure Docker configuration service is initialized before reconnecting
        if (!this.dockerConfigService || typeof this.dockerConfigService.get !== 'function') {
          this.dockerConfigService = new DockerConfigService(prisma);
        }
        
        // Recreate client from current settings before reconnecting
        await this.createDockerClientFromSettings();
        await this.connect(true); // Allow scheduling reconnect in background
      } catch (error) {
        servicesLogger().error({ error }, "Reconnection attempt failed");
      }
    }, 10000); // Try every 10 seconds
  }

  /**
   * Create Docker client with specified configuration
   * This method is copied from DockerConfigService to maintain consistency
   */
  private createDockerClient(host: string, apiVersion?: string | null): Docker {
    let dockerConfig: any = {};

    // Parse Docker host configuration
    if (host.startsWith("npipe://")) {
      // Windows named pipe - dockerode expects just the pipe path
      dockerConfig.socketPath = host.replace("npipe://", "");
    } else if (host.startsWith("unix://")) {
      // Unix socket with unix:// prefix
      dockerConfig.socketPath = host.replace("unix://", "");
    } else if (
      host.startsWith("tcp://") ||
      host.startsWith("http://") ||
      host.startsWith("https://")
    ) {
      // TCP connection
      const url = new URL(host);
      dockerConfig.host = url.hostname;
      dockerConfig.port = parseInt(url.port || "2375");
      if (host.startsWith("https://")) {
        dockerConfig.protocol = "https";
      } else {
        dockerConfig.protocol = "http";
      }
    } else if (
      host.startsWith("/") ||
      host.startsWith("\\") ||
      host.includes("pipe")
    ) {
      // Direct socket path (Windows named pipe or Unix socket)
      dockerConfig.socketPath = host;
    } else {
      // Assume it's a host:port format
      const parts = host.split(":");
      dockerConfig.host = parts[0];
      dockerConfig.port = parseInt(parts[1] || "2375");
      dockerConfig.protocol = "http";
    }

    // Add API version if specified
    if (apiVersion) {
      dockerConfig.version = apiVersion.startsWith("v")
        ? apiVersion
        : `v${apiVersion}`;
    }

    return new Docker(dockerConfig);
  }

  /**
   * Extract Docker-specific error codes
   */
  private getDockerErrorCode(error: any): string | undefined {
    if (error && typeof error === "object") {
      if (error.statusCode) {
        return `HTTP_${error.statusCode}`;
      }
      if (error.code) {
        return error.code;
      }
      if (error.errno) {
        return `ERRNO_${error.errno}`;
      }
    }
    return undefined;
  }

  private setupEventListeners(): void {
    // Subscribe to Docker events for cache invalidation
    this.docker.getEvents({}, (err, stream) => {
      if (err) {
        servicesLogger().error(
          { error: err },
          "Failed to subscribe to Docker events",
        );
        return;
      }

      if (stream) {
        stream.on("data", (data) => {
          try {
            const event = JSON.parse(data.toString());
            if (event.Type === "container") {
              servicesLogger().debug(
                {
                  action: event.Action,
                  containerId: event.id,
                },
                "Container event received, invalidating cache",
              );
              this.cache.flushAll();
            }
          } catch (error) {
            servicesLogger().error({ error }, "Failed to parse Docker event");
          }
        });

        stream.on("error", (error) => {
          servicesLogger().error({ error }, "Docker events stream error");
        });
      }
    });
  }

  private createTimeoutPromise<T>(timeoutMs: number, errorMessage: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    // Add cleanup method to the promise
    (timeoutPromise as any).cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    return timeoutPromise;
  }

  private async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    const timeoutPromise = this.createTimeoutPromise<T>(timeoutMs, errorMessage);

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      (timeoutPromise as any).cleanup();
      return result;
    } catch (error) {
      (timeoutPromise as any).cleanup();
      throw error;
    }
  }

  public async listContainers(all = true): Promise<DockerContainerInfo[]> {
    if (!this.connected) {
      throw new Error("Docker service not connected");
    }

    const cacheKey = `containers_${all}`;
    const cached = this.cache.get<DockerContainerInfo[]>(cacheKey);

    if (cached) {
      servicesLogger().debug("Returning cached container list");
      return cached;
    }

    try {
      const containers = await this.raceWithTimeout(
        this.docker.listContainers({ all }),
        5000,
        "Docker API timeout",
      );

      const containerInfos = await Promise.all(
        containers.map((container) => this.transformContainerData(container)),
      );

      this.cache.set(cacheKey, containerInfos);
      servicesLogger().info(
        `Retrieved ${containerInfos.length} containers from Docker API`,
      );

      return containerInfos;
    } catch (error) {
      servicesLogger().error({ error }, "Failed to list containers");
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
      const data = await this.raceWithTimeout(
        container.inspect(),
        5000,
        "Docker API timeout",
      );

      const containerInfo = this.transformDetailedContainerData(data);
      this.cache.set(cacheKey, containerInfo);

      return containerInfo;
    } catch (error) {
      if ((error as any).statusCode === 404) {
        return null;
      }
      servicesLogger().error(
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
    servicesLogger().info("Docker service cache flushed");
  }

  /**
   * Get the underlying Docker client instance
   * This should only be used by services that need direct Docker API access
   * for operations not covered by the high-level methods
   */
  public async getDockerInstance(): Promise<Docker> {
    if (!this.connected) {
      throw new Error("Docker service not connected");
    }
    
    if (!this.docker || typeof this.docker.ping !== "function") {
      throw new Error("Docker client not initialized");
    }
    
    return this.docker;
  }

  /**
   * Refresh Docker connection with updated settings
   * This method can be called when Docker settings are updated
   */
  public async refreshConnection(): Promise<void> {
    servicesLogger().info(
      "Refreshing Docker connection with updated settings...",
    );

    try {
      // Stop current reconnection attempts
      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }

      // Ensure Docker configuration service is initialized
      if (!this.dockerConfigService || typeof this.dockerConfigService.get !== 'function') {
        this.dockerConfigService = new DockerConfigService(prisma);
      }

      // Recreate Docker client with updated settings
      await this.createDockerClientFromSettings();

      // Attempt new connection
      await this.connect(true);

      // Setup event listeners for new connection
      this.setupEventListeners();

      servicesLogger().info("Docker connection refreshed successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to refresh Docker connection",
      );

      // Schedule reconnect attempts
      this.scheduleReconnect();

      throw error;
    }
  }
}

export default DockerService;
