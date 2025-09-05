import Docker, { Container } from "dockerode";
import { Readable, Writable } from "stream";
import { servicesLogger } from "../lib/logger-factory";
import { DockerConfigService } from "./docker-config";
import prisma from "../lib/prisma";

export interface ContainerExecutionOptions {
  image: string;
  env: Record<string, string>;
  timeout?: number; // in milliseconds
  removeContainer?: boolean;
  outputHandler?: (stream: Readable) => void;
}

export interface ContainerExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  containerId?: string;
}

export interface ContainerProgress {
  status: "starting" | "running" | "completed" | "failed" | "timeout";
  containerId?: string;
  executionTimeMs?: number;
  exitCode?: number;
  errorMessage?: string;
}

/**
 * DockerExecutor service for executing Docker containers for backup and restore operations
 */
export class DockerExecutorService {
  private docker: Docker;
  private dockerConfigService: DockerConfigService;
  private static readonly DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  constructor() {
    this.dockerConfigService = new DockerConfigService(prisma);
    // Initialize Docker client - will be set up asynchronously
    this.docker = {} as Docker;
  }

  /**
   * Initialize Docker client with current settings
   */
  public async initialize(): Promise<void> {
    try {
      // Get Docker configuration from database settings
      const dockerHost = await this.dockerConfigService.get("host");
      const apiVersion = await this.dockerConfigService.get("apiVersion");

      if (!dockerHost) {
        throw new Error("Docker host not configured in database settings");
      }

      this.docker = this.createDockerClient(dockerHost, apiVersion);

      // Test connection
      await this.docker.ping();
      servicesLogger().info("DockerExecutor initialized successfully");
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
   * Execute a container with the specified configuration
   */
  public async executeContainer(
    options: ContainerExecutionOptions,
  ): Promise<ContainerExecutionResult> {
    const startTime = Date.now();
    let container: Container | undefined;
    let stdout = "";
    let stderr = "";

    try {
      servicesLogger().info(
        {
          image: options.image,
          envKeys: Object.keys(options.env),
          timeout: options.timeout || DockerExecutorService.DEFAULT_TIMEOUT,
        },
        "Starting container execution",
      );

      // Create container
      container = await this.createContainer(options);
      const containerId = container.id;

      servicesLogger().info({ containerId }, "Container created successfully");

      // Set up output capture
      const outputCapture = await this.attachToContainer(container);

      // Capture stdout and stderr
      outputCapture.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.outputHandler) {
          options.outputHandler(Readable.from([chunk]));
        }
      });

      outputCapture.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        servicesLogger().debug({ containerId, stderr: chunk }, "Container stderr");
      });

      // Start container
      await container.start();
      servicesLogger().info({ containerId }, "Container started");

      // Wait for container completion with timeout
      const result = await this.waitForContainer(
        container,
        options.timeout || DockerExecutorService.DEFAULT_TIMEOUT,
      );

      const executionTimeMs = Date.now() - startTime;

      servicesLogger().info(
        {
          containerId,
          exitCode: result.exitCode,
          executionTimeMs,
        },
        "Container execution completed",
      );

      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        executionTimeMs,
        containerId,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      servicesLogger().error(
        {
          error: errorMessage,
          containerId: container?.id,
          executionTimeMs,
        },
        "Container execution failed",
      );

      return {
        exitCode: -1,
        stdout,
        stderr: stderr + `\nExecution error: ${errorMessage}`,
        executionTimeMs,
        containerId: container?.id,
      };
    } finally {
      // Clean up container if requested and it exists
      if (container && options.removeContainer !== false) {
        await this.cleanupContainer(container);
      }
    }
  }

  /**
   * Execute container with progress monitoring
   */
  public async executeContainerWithProgress(
    options: ContainerExecutionOptions,
    progressCallback?: (progress: ContainerProgress) => void,
  ): Promise<ContainerExecutionResult> {
    const startTime = Date.now();

    try {
      // Report starting status
      progressCallback?.({
        status: "starting",
      });

      const result = await this.executeContainer({
        ...options,
        outputHandler: (stream) => {
          // Report running status on first output
          progressCallback?.({
            status: "running",
            containerId: result.containerId,
          });
          options.outputHandler?.(stream);
        },
      });

      // Report completion status
      const finalStatus = result.exitCode === 0 ? "completed" : "failed";
      progressCallback?.({
        status: finalStatus,
        containerId: result.containerId,
        executionTimeMs: result.executionTimeMs,
        exitCode: result.exitCode,
        errorMessage: result.exitCode !== 0 ? result.stderr : undefined,
      });

      return result;
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      progressCallback?.({
        status: "failed",
        executionTimeMs,
        errorMessage,
      });

      throw error;
    }
  }

  /**
   * Get the status of a running container
   */
  public async getContainerStatus(containerId: string): Promise<{
    status: string;
    running: boolean;
    exitCode?: number;
  }> {
    try {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();

      return {
        status: data.State.Status,
        running: data.State.Running,
        exitCode: data.State.ExitCode,
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerId,
        },
        "Failed to get container status",
      );
      throw error;
    }
  }

  /**
   * Stop a running container
   */
  public async stopContainer(
    containerId: string,
    forceKill = false,
  ): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);

      if (forceKill) {
        await container.kill();
        servicesLogger().info({ containerId }, "Container killed");
      } else {
        await container.stop();
        servicesLogger().info({ containerId }, "Container stopped");
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerId,
        },
        "Failed to stop container",
      );
      throw error;
    }
  }

  /**
   * Create Docker container with specified options
   */
  private async createContainer(
    options: ContainerExecutionOptions,
  ): Promise<Container> {
    try {
      // Convert environment variables to Docker format
      const env = Object.entries(options.env).map(
        ([key, value]) => `${key}=${value}`,
      );

      const containerOptions = {
        Image: options.image,
        Env: env,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        // Auto-remove container after execution if removeContainer is not false
        AutoRemove: options.removeContainer !== false,
        // Set resource limits for safety
        HostConfig: {
          Memory: 2 * 1024 * 1024 * 1024, // 2GB memory limit
          CpuShares: 1024, // Standard CPU allocation
        },
      };

      return await this.docker.createContainer(containerOptions);
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          image: options.image,
        },
        "Failed to create container",
      );
      throw error;
    }
  }

  /**
   * Attach to container for output streaming
   */
  private async attachToContainer(container: Container): Promise<{
    stdout?: Readable;
    stderr?: Readable;
  }> {
    try {
      const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      // Demultiplex Docker stream
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });

      // Docker multiplexes stdout and stderr in a single stream
      // Each chunk has an 8-byte header: [stream_type, 0, 0, 0, size_bytes...]
      stream.on("data", (chunk: Buffer) => {
        if (chunk.length < 8) return;

        const streamType = chunk.readUInt8(0);
        const size = chunk.readUInt32BE(4);
        const data = chunk.subarray(8, 8 + size);

        if (streamType === 1) {
          stdout.push(data);
        } else if (streamType === 2) {
          stderr.push(data);
        }
      });

      stream.on("end", () => {
        stdout.push(null);
        stderr.push(null);
      });

      return { stdout, stderr };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerId: container.id,
        },
        "Failed to attach to container",
      );
      throw error;
    }
  }

  /**
   * Wait for container completion with timeout
   */
  private async waitForContainer(
    container: Container,
    timeoutMs: number,
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Container execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      container
        .wait()
        .then((data) => {
          clearTimeout(timeout);
          resolve({ exitCode: data.StatusCode });
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  /**
   * Clean up container after execution
   */
  private async cleanupContainer(container: Container): Promise<void> {
    try {
      // Check if container still exists
      const data = await container.inspect();

      // Remove container if it exists and is not already being removed
      if (data.State.Status !== "removing") {
        await container.remove({ force: true });
        servicesLogger().debug({ containerId: container.id }, "Container cleaned up");
      }
    } catch (error) {
      // Log but don't throw - cleanup failure shouldn't fail the operation
      if ((error as any).statusCode === 404) {
        servicesLogger().debug(
          { containerId: container.id },
          "Container already removed",
        );
      } else {
        servicesLogger().warn(
          {
            error: error instanceof Error ? error.message : "Unknown error",
            containerId: container.id,
          },
          "Failed to clean up container",
        );
      }
    }
  }

  /**
   * Create Docker client with specified configuration
   * This method is copied from DockerService to maintain consistency
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
}
