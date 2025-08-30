import Docker from "dockerode";
import { ConfigurationService } from "./configuration-base";
import {
  ValidationResult,
  ServiceHealthStatus,
  SettingsCategory,
  ConnectivityService,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { PrismaClient } from "../generated/prisma";
import logger from "../lib/logger";

export class DockerConfigService extends ConfigurationService {
  private docker: Docker | null = null;
  private readonly DEFAULT_TIMEOUT = 5000; // 5 seconds

  constructor(prisma: PrismaClient) {
    super(prisma, "docker" as SettingsCategory);
  }

  /**
   * Validate Docker host connectivity and configuration
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();
    let docker: Docker | null = null;

    try {
      // Get Docker configuration from settings
      const dockerHost = await this.get("host");
      const apiVersion = await this.get("apiVersion");

      // Use default if no host configured
      const host = dockerHost || this.getDefaultDockerHost();

      logger.info(
        {
          host: host,
          apiVersion: apiVersion,
        },
        "Validating Docker configuration",
      );

      // Create Docker client with configuration
      docker = this.createDockerClient(host, apiVersion);

      // Test connectivity with timeout
      const pingResult = await Promise.race([
        docker.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Docker API timeout")),
            this.DEFAULT_TIMEOUT,
          ),
        ),
      ]);

      const responseTimeMs = Date.now() - startTime;

      // Validate ping result (can be string "OK" or Buffer with "OK")
      // Handle Buffer, string, or other types and normalize whitespace
      let pingString: string;
      if (pingResult instanceof Buffer) {
        pingString = pingResult.toString().trim();
      } else if (typeof pingResult === 'string') {
        pingString = pingResult.trim();
      } else {
        pingString = String(pingResult).trim();
      }
      
      logger.debug({
        pingResult,
        pingResultType: typeof pingResult,
        isBuffer: pingResult instanceof Buffer,
        pingString,
        pingStringNormalized: pingString
      }, "Docker ping result details");
      
      // Check for successful ping - Docker API should return "OK" (case insensitive)
      if (pingString.toLowerCase() !== "ok") {
        const errorMessage = `Docker ping failed: ${pingString}`;
        logger.warn({ pingResult, pingString, originalResult: pingResult }, errorMessage);
        
        // Record failed connectivity
        await this.recordConnectivityStatus(
          "failed",
          responseTimeMs,
          errorMessage,
          "PING_FAILED",
        );

        return {
          isValid: false,
          message: errorMessage,
          errorCode: "PING_FAILED",
          responseTimeMs,
        };
      }

      // Get additional Docker info for metadata
      const dockerInfo = await docker.info();
      const dockerVersion = await docker.version();

      const metadata = {
        serverVersion: dockerVersion.Version,
        apiVersion: dockerVersion.ApiVersion,
        platform: dockerInfo.OperatingSystem,
        architecture: dockerInfo.Architecture,
        containers: dockerInfo.Containers,
        images: dockerInfo.Images,
      };

      // Record successful connectivity
      await this.recordConnectivityStatus(
        "connected",
        responseTimeMs,
        undefined,
        undefined,
        metadata,
      );

      logger.info(
        {
          responseTimeMs,
          serverVersion: dockerVersion.Version,
        },
        "Docker validation successful",
      );

      return {
        isValid: true,
        message: `Docker connection successful (${responseTimeMs}ms)`,
        responseTimeMs,
        metadata,
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorCode = this.getDockerErrorCode(error);

      logger.error(
        {
          error: errorMessage,
          errorCode,
          responseTimeMs,
        },
        "Docker validation failed",
      );

      // Record failed connectivity
      await this.recordConnectivityStatus(
        this.mapErrorToStatus(error),
        responseTimeMs,
        errorMessage,
        errorCode,
      );

      return {
        isValid: false,
        message: `Docker connection failed: ${errorMessage}`,
        errorCode,
        responseTimeMs,
      };
    }
  }

  /**
   * Get current health status of Docker service
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      return {
        service: "docker" as ConnectivityService,
        status: "unreachable" as ConnectivityStatusType,
        lastChecked: new Date(),
        errorMessage: "No connectivity data available",
      };
    }

    return {
      service: "docker" as ConnectivityService,
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt || undefined,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Test Docker API connectivity with current or provided configuration
   */
  async testConnection(
    host?: string,
    apiVersion?: string,
  ): Promise<ValidationResult> {
    const testHost =
      host || (await this.get("host")) || this.getDefaultDockerHost();
    const testApiVersion = apiVersion || (await this.get("apiVersion"));

    const startTime = Date.now();

    try {
      const docker = this.createDockerClient(testHost, testApiVersion);

      // Test basic connectivity
      await Promise.race([
        docker.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Connection timeout")),
            this.DEFAULT_TIMEOUT,
          ),
        ),
      ]);

      const responseTimeMs = Date.now() - startTime;

      // Get version info
      const version = await docker.version();

      return {
        isValid: true,
        message: "Docker connection test successful",
        responseTimeMs,
        metadata: {
          serverVersion: version.Version,
          apiVersion: version.ApiVersion,
        },
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      return {
        isValid: false,
        message: `Docker connection test failed: ${errorMessage}`,
        errorCode: this.getDockerErrorCode(error),
        responseTimeMs,
      };
    }
  }

  /**
   * Get Docker system information
   */
  async getDockerInfo(): Promise<any> {
    try {
      const docker = await this.getDockerClient();
      return await docker.info();
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get Docker info",
      );
      throw error;
    }
  }

  /**
   * Get Docker version information
   */
  async getDockerVersion(): Promise<any> {
    try {
      const docker = await this.getDockerClient();
      return await docker.version();
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get Docker version",
      );
      throw error;
    }
  }

  /**
   * Create Docker client with specified configuration
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
   * Get Docker client instance with current settings
   */
  private async getDockerClient(): Promise<Docker> {
    if (!this.docker) {
      const host = (await this.get("host")) || this.getDefaultDockerHost();
      const apiVersion = await this.get("apiVersion");
      this.docker = this.createDockerClient(host, apiVersion);
    }
    return this.docker;
  }

  /**
   * Get default Docker host based on platform
   */
  private getDefaultDockerHost(): string {
    if (process.platform === "win32") {
      // Windows: Use named pipe for Docker Desktop
      return "//./pipe/docker_engine";
    } else {
      // Unix/Linux/Mac: Use Unix socket
      return "/var/run/docker.sock";
    }
  }

  /**
   * Map Docker errors to connectivity status
   */
  private mapErrorToStatus(error: any): ConnectivityStatusType {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timeout")) {
        return "timeout";
      } else if (
        message.includes("econnrefused") ||
        message.includes("connect")
      ) {
        return "unreachable";
      }
    }
    return "failed";
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

  /**
   * Record connectivity status - public method to allow main Docker service to record status
   */
  async recordConnectivityStatus(
    status: ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, any>,
    userId?: string,
  ): Promise<void> {
    return super.recordConnectivityStatus(
      status,
      responseTimeMs,
      errorMessage,
      errorCode,
      metadata,
      userId,
    );
  }

  /**
   * Override set method to invalidate cached Docker client and refresh main service
   */
  async set(key: string, value: string, userId: string): Promise<void> {
    await super.set(key, value, userId);

    // Invalidate cached Docker client when configuration changes
    this.docker = null;

    logger.info(
      {
        key,
        userId,
      },
      "Docker configuration updated, client cache invalidated",
    );

    // Notify main Docker service to refresh connection
    try {
      const DockerService = (await import("./docker")).default;
      const dockerService = DockerService.getInstance();
      await dockerService.refreshConnection();
      logger.info(
        "Main Docker service connection refreshed after settings update",
      );
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to refresh main Docker service connection after settings update",
      );
    }
  }
}
