import Docker from "dockerode";
import { servicesLogger } from "../../lib/logger-factory";
import { DockerConfigService } from "../docker-config";

/**
 * DockerClientFactory - Creates and initializes Docker client connections
 */
export class DockerClientFactory {
  private dockerConfigService: DockerConfigService;

  constructor(dockerConfigService: DockerConfigService) {
    this.dockerConfigService = dockerConfigService;
  }

  /**
   * Initialize Docker client with current settings
   * Returns the connected Docker client instance
   */
  public async initialize(): Promise<Docker> {
    try {
      // Get Docker configuration from database settings
      const dockerHost = await this.dockerConfigService.get("host");
      const apiVersion = await this.dockerConfigService.get("apiVersion");

      if (!dockerHost) {
        throw new Error("Docker host not configured in database settings");
      }

      const docker = this.createDockerClient(dockerHost, apiVersion);

      // Test connection
      await docker.ping();
      servicesLogger().info("DockerExecutor initialized successfully");

      return docker;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to initialize DockerExecutor",
      );
      throw error;
    }
  }

  /**
   * Create Docker client with specified configuration
   */
  public createDockerClient(host: string, apiVersion?: string | null): Docker {
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
}
