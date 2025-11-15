import Docker, { Container } from "dockerode";
import { Readable, Writable } from "stream";
import { servicesLogger, dockerExecutorLogger } from "../lib/logger-factory";
import { DockerConfigService } from "./docker-config";
import ContainerLabelManager from "./container-label-manager";
import { RegistryCredentialService } from "./registry-credential";
import prisma from "../lib/prisma";

export interface ContainerExecutionOptions {
  image: string;
  env: Record<string, string>;
  timeout?: number; // in milliseconds
  removeContainer?: boolean;
  outputHandler?: (stream: Readable) => void;
  cmd?: string[]; // Custom command to run in container
  networkMode?: string; // Docker network to attach to
  binds?: string[]; // Volume binds in format "volume:/path:ro" or "/host/path:/container/path"
  // Compose-style grouping options
  projectName?: string; // Docker Compose project name
  serviceName?: string; // Docker Compose service name
  labels?: Record<string, string>; // Additional custom labels
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

export interface DockerRegistryTestOptions {
  image: string;
  registryUsername?: string;
  registryPassword?: string;
}

export interface DockerRegistryTestResult {
  success: boolean;
  message: string;
  details: {
    image: string;
    authenticated: boolean;
    pullTimeMs?: number;
    errorCode?: string;
  };
}

/**
 * DockerExecutorService - Executes short-lived, task-specific Docker containers
 * 
 * This service is designed for running ephemeral containers that perform specific tasks
 * and then terminate, such as database operations, file processing, or utility scripts.
 * 
 * Key characteristics:
 * - Creates temporary containers that auto-remove after execution
 * - Captures and streams container output (stdout/stderr)  
 * - Handles timeouts and resource limits for safety
 * - Supports Docker registry authentication for image pulling
 * - Uses centralized labeling for container identification and cleanup
 * 
 * Primary use cases:
 * - Database backup/restore operations (pg_dump, pg_restore)
 * - File processing tasks
 * - Image registry connectivity testing
 * - One-time utility scripts
 * - Background job execution
 * 
 * Do NOT use for:
 * - Long-running application containers (use ContainerLifecycleManager instead)
 * - Web services or APIs
 * - Containers that need persistent networking or volumes
 * - Blue-green deployment containers
 */
export class DockerExecutorService {
  private docker: Docker;
  private dockerConfigService: DockerConfigService;
  private labelManager: ContainerLabelManager;
  private registryCredentialService: RegistryCredentialService;
  private static readonly DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  constructor() {
    this.dockerConfigService = new DockerConfigService(prisma);
    this.labelManager = new ContainerLabelManager();
    this.registryCredentialService = new RegistryCredentialService(prisma);
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
   * Get the Docker network name from system settings
   */
  public async getDockerNetworkName(): Promise<string> {
    try {
      const networkSetting = await prisma.systemSettings.findFirst({
        where: {
          category: "system",
          key: "docker_network_name",
        },
      });

      const networkName = networkSetting?.value || "mini-infra-network";

      servicesLogger().debug(
        {
          networkName,
          fromSettings: !!networkSetting?.value,
        },
        "Retrieved Docker network name for container operations",
      );

      return networkName;
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get Docker network name from settings, using default",
      );
      return "mini-infra-network";
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
        // Log container stdout to dedicated dockerexecutor logger with full container context
        dockerExecutorLogger().debug(
          {
            containerId,
            image: options.image,
            envKeys: Object.keys(options.env),
            timeout: options.timeout || DockerExecutorService.DEFAULT_TIMEOUT,
            stdout: chunk,
          },
          "Container stdout",
        );
        if (options.outputHandler) {
          options.outputHandler(Readable.from([chunk]));
        }
      });

      outputCapture.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // Log container stderr to dedicated dockerexecutor logger with full container context
        dockerExecutorLogger().debug(
          {
            containerId,
            image: options.image,
            envKeys: Object.keys(options.env),
            timeout: options.timeout || DockerExecutorService.DEFAULT_TIMEOUT,
            stderr: chunk,
          },
          "Container stderr",
        );
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

      const result = await this.executeContainer(options);

      // Note: We can't easily capture the container ID during execution
      // for the progress callback without modifying executeContainer significantly
      // The progress callback will receive container ID in the final status

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

      const containerOptions: any = {
        Image: options.image,
        Env: env,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        // Auto-remove container after execution if removeContainer is not false
        AutoRemove: options.removeContainer !== false,
        // Add labels using the centralized label manager
        Labels: this.labelManager.generateTaskExecutionLabels({
          projectName: options.projectName,
          serviceName: options.serviceName,
          containerPurpose: "task",
          isTemporary: options.removeContainer !== false,
          taskType: this.inferTaskType(options),
          taskId: this.generateTaskId(options),
          outputCapture: !!options.outputHandler,
          timeout: options.timeout,
          customLabels: options.labels,
        }),
        HostConfig: {},
      };

      // Add custom command if provided
      if (options.cmd) {
        containerOptions.Cmd = options.cmd;
      }

      // Add network mode if provided
      if (options.networkMode) {
        containerOptions.HostConfig.NetworkMode = options.networkMode;
      }

      // Add volume binds if provided
      if (options.binds && options.binds.length > 0) {
        containerOptions.HostConfig.Binds = options.binds;
      }

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
      const stdout = new Readable({ read() { } });
      const stderr = new Readable({ read() { } });

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
        servicesLogger().debug(
          { containerId: container.id },
          "Container cleaned up",
        );
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

  /**
   * Pull Docker image with authentication if credentials are provided
   * Used by backup/restore operations to ensure images are available locally
   */
  public async pullImageWithAuth(
    image: string,
    registryUsername?: string,
    registryPassword?: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      servicesLogger().info(
        {
          image,
          hasAuth: !!(registryUsername && registryPassword),
        },
        "Pulling Docker image with authentication",
      );

      // Prepare authentication if credentials are provided
      let authconfig: any = {};
      if (registryUsername && registryPassword) {
        authconfig = {
          username: registryUsername,
          password: registryPassword,
        };
      }

      // Attempt to pull the image
      const stream = await this.docker.pull(image, { authconfig });

      // Wait for the pull to complete
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            reject(new Error("Docker pull timeout after 10 minutes"));
          },
          10 * 60 * 1000,
        ); // 10 minute timeout

        this.docker.modem.followProgress(stream, (err, result) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const pullTimeMs = Date.now() - startTime;

      servicesLogger().info(
        {
          image,
          pullTimeMs,
          authenticated: !!(registryUsername && registryPassword),
        },
        "Docker image pulled successfully",
      );
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      servicesLogger().error(
        {
          error: errorMessage,
          image,
          pullTimeMs,
          authenticated: !!(registryUsername && registryPassword),
        },
        "Failed to pull Docker image",
      );

      // Enhance error message for better debugging
      if (
        errorMessage.includes("authentication required") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401")
      ) {
        throw new Error(
          `Authentication required for image '${image}' - please provide valid registry credentials`,
        );
      } else if (
        errorMessage.includes("repository does not exist") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("404")
      ) {
        throw new Error(`Docker image '${image}' not found in registry`);
      } else if (errorMessage.includes("timeout")) {
        throw new Error(
          `Timeout pulling image '${image}' - registry may be unreachable`,
        );
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection refused")
      ) {
        throw new Error(
          `Network error pulling image '${image}' - cannot reach Docker registry`,
        );
      }

      throw new Error(`Failed to pull image '${image}': ${errorMessage}`);
    }
  }

  /**
   * Pull Docker image with automatic credential resolution
   * Automatically finds and applies registry credentials from the database
   */
  public async pullImageWithAutoAuth(image: string): Promise<void> {
    servicesLogger().info({ image }, "Pulling image with automatic authentication");

    try {
      // Attempt to find credentials for this image's registry
      const credentials = await this.registryCredentialService.getCredentialsForImage(image);

      if (credentials) {
        servicesLogger().info(
          { image, hasCredentials: true },
          "Found registry credentials for image",
        );
        // Pull with credentials
        return this.pullImageWithAuth(
          image,
          credentials.username,
          credentials.password,
        );
      } else {
        servicesLogger().info(
          { image, hasCredentials: false },
          "No registry credentials found, attempting anonymous pull",
        );
        // No credentials - attempt anonymous pull
        return this.pullImageWithAuth(image);
      }
    } catch (error) {
      servicesLogger().error(
        { error, image },
        "Failed to pull image with auto-auth",
      );
      throw error;
    }
  }

  /**
   * Test Docker registry connection by attempting to pull an image
   */
  public async testDockerRegistryConnection(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    const startTime = Date.now();
    let authenticated = false;

    try {
      servicesLogger().info(
        {
          image: options.image,
          hasAuth: !!(options.registryUsername && options.registryPassword),
        },
        "Testing Docker registry connection",
      );

      // Prepare authentication if credentials are provided
      let authconfig: any = {};
      if (options.registryUsername && options.registryPassword) {
        authenticated = true;
        authconfig = {
          username: options.registryUsername,
          password: options.registryPassword,
        };
      }

      // Attempt to pull the image
      const stream = await this.docker.pull(options.image, { authconfig });

      // Wait for the pull to complete
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            reject(new Error("Docker pull timeout after 10 minutes"));
          },
          10 * 60 * 1000,
        ); // 10 minute timeout

        this.docker.modem.followProgress(stream, (err, result) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const pullTimeMs = Date.now() - startTime;

      servicesLogger().info(
        {
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry connection test successful",
      );

      return {
        success: true,
        message: authenticated
          ? "Successfully connected to Docker registry with authentication and verified image access"
          : "Successfully connected to Docker registry and verified image access",
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
        },
      };
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      servicesLogger().error(
        {
          error: errorMessage,
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry connection test failed",
      );

      // Determine error type for better user feedback
      let userMessage = "Failed to connect to Docker registry";
      let errorCode = "CONNECTION_FAILED";

      if (
        errorMessage.includes("authentication required") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401")
      ) {
        userMessage =
          "Authentication required - please provide valid registry credentials";
        errorCode = "AUTHENTICATION_REQUIRED";
      } else if (
        errorMessage.includes("repository does not exist") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("404")
      ) {
        userMessage = "Docker image not found in registry";
        errorCode = "IMAGE_NOT_FOUND";
      } else if (errorMessage.includes("timeout")) {
        userMessage = "Connection timeout - registry may be unreachable";
        errorCode = "TIMEOUT";
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection refused")
      ) {
        userMessage = "Network error - cannot reach Docker registry";
        errorCode = "NETWORK_ERROR";
      }

      return {
        success: false,
        message: `${userMessage}: ${errorMessage}`,
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
          errorCode,
        },
      };
    }
  }

  /**
   * Fast registry credential test using Docker Registry API v2
   * Only checks authentication without pulling the image
   */
  public async testDockerRegistryCredentialsFast(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    const startTime = Date.now();
    let authenticated = false;

    try {
      servicesLogger().info(
        {
          image: options.image,
          hasAuth: !!(options.registryUsername && options.registryPassword),
        },
        "Testing Docker registry credentials (fast check)",
      );

      authenticated = !!(options.registryUsername && options.registryPassword);

      // Parse the image name to extract registry, repository, and tag
      const imageParts = this.parseImageName(options.image);

      // Get authentication token (handles both Basic auth and OAuth2 token flow)
      const authHeader = await this.getRegistryAuthHeader(
        imageParts.registry,
        imageParts.repository,
        options.registryUsername,
        options.registryPassword,
      );

      // Build the registry API URL for manifest check
      const manifestUrl = `https://${imageParts.registry}/v2/${imageParts.repository}/manifests/${imageParts.tag}`;

      // Prepare authentication headers
      const headers: Record<string, string> = {
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      };

      if (authHeader) {
        headers.Authorization = authHeader;
      }

      // Make HEAD request to check manifest exists and credentials work
      const response = await fetch(manifestUrl, {
        method: "HEAD",
        headers,
      });

      const pullTimeMs = Date.now() - startTime;

      if (response.ok) {
        servicesLogger().info(
          {
            image: options.image,
            pullTimeMs,
            authenticated,
            statusCode: response.status,
          },
          "Docker registry credential test successful (fast check)",
        );

        return {
          success: true,
          message: authenticated
            ? "Successfully authenticated with Docker registry and verified image access"
            : "Successfully verified image access to Docker registry",
          details: {
            image: options.image,
            authenticated,
            pullTimeMs,
          },
        };
      } else if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Authentication failed: ${response.status} ${response.statusText}`,
        );
      } else if (response.status === 404) {
        throw new Error(
          `Image not found: ${response.status} ${response.statusText}`,
        );
      } else {
        throw new Error(
          `Registry error: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      servicesLogger().error(
        {
          error: errorMessage,
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry credential test failed (fast check)",
      );

      // Determine error type for better user feedback
      let userMessage = "Failed to connect to Docker registry";
      let errorCode = "CONNECTION_FAILED";

      if (
        errorMessage.includes("Authentication failed") ||
        errorMessage.includes("401") ||
        errorMessage.includes("403")
      ) {
        userMessage = "Authentication failed - invalid credentials";
        errorCode = "AUTHENTICATION_FAILED";
      } else if (errorMessage.includes("404") || errorMessage.includes("not found")) {
        userMessage = "Image not found in registry";
        errorCode = "IMAGE_NOT_FOUND";
      } else if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
        userMessage = "Connection timeout - registry may be unreachable";
        errorCode = "TIMEOUT";
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("connection refused")
      ) {
        userMessage = "Network error - cannot reach Docker registry";
        errorCode = "NETWORK_ERROR";
      }

      return {
        success: false,
        message: `${userMessage}: ${errorMessage}`,
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
          errorCode,
        },
      };
    }
  }

  /**
   * Get authentication header for Docker registry
   * Handles both Basic auth and OAuth2 token flow
   */
  private async getRegistryAuthHeader(
    registry: string,
    repository: string,
    username?: string,
    password?: string,
  ): Promise<string | null> {
    if (!username || !password) {
      return null;
    }

    try {
      // First, try to get authentication challenge from registry
      const testUrl = `https://${registry}/v2/`;
      const testResponse = await fetch(testUrl, { method: "GET" });

      // Check if registry requires token authentication
      const wwwAuthenticate = testResponse.headers.get("www-authenticate");

      if (wwwAuthenticate && wwwAuthenticate.includes("Bearer")) {
        // Extract realm and service from WWW-Authenticate header
        const realmMatch = wwwAuthenticate.match(/realm="([^"]+)"/);
        const serviceMatch = wwwAuthenticate.match(/service="([^"]+)"/);

        if (realmMatch) {
          const realm = realmMatch[1];
          const service = serviceMatch ? serviceMatch[1] : registry;

          // Build token URL
          const tokenUrl = new URL(realm);
          tokenUrl.searchParams.set("service", service);
          tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);

          // Request token with Basic auth
          const authString = Buffer.from(`${username}:${password}`).toString("base64");
          const tokenResponse = await fetch(tokenUrl.toString(), {
            headers: {
              Authorization: `Basic ${authString}`,
            },
          });

          if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            if (tokenData.token) {
              servicesLogger().debug(
                { registry, repository },
                "Successfully obtained OAuth2 token for registry",
              );
              return `Bearer ${tokenData.token}`;
            } else if (tokenData.access_token) {
              return `Bearer ${tokenData.access_token}`;
            }
          }
        }
      }

      // Fall back to Basic authentication
      servicesLogger().debug(
        { registry },
        "Using Basic authentication for registry",
      );
      const authString = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${authString}`;
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : String(error),
          registry,
        },
        "Failed to get registry auth header, falling back to Basic auth",
      );

      // Fall back to Basic auth on any error
      const authString = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${authString}`;
    }
  }

  /**
   * Parse Docker image name into registry, repository, and tag components
   */
  private parseImageName(imageName: string): {
    registry: string;
    repository: string;
    tag: string;
  } {
    // Default values
    let registry = "registry-1.docker.io";
    let repository = imageName;
    let tag = "latest";

    // Split by tag first
    const tagSplit = imageName.split(":");
    if (tagSplit.length > 1) {
      tag = tagSplit[tagSplit.length - 1];
      imageName = tagSplit.slice(0, -1).join(":");
    }

    // Check if there's a registry (contains . or :)
    const parts = imageName.split("/");
    if (parts[0].includes(".") || parts[0].includes(":")) {
      registry = parts[0];
      repository = parts.slice(1).join("/");
    } else {
      // Docker Hub format
      registry = "registry-1.docker.io";
      // If only one part, it's library/image format
      if (parts.length === 1) {
        repository = `library/${parts[0]}`;
      } else {
        repository = imageName;
      }
    }

    return { registry, repository, tag };
  }

  /**
   * Infer the task type from container execution options
   */
  private inferTaskType(options: ContainerExecutionOptions): string {
    if (options.image.includes("postgres") || options.image.includes("pg_")) {
      if (options.cmd?.some(cmd => cmd.includes("pg_dump"))) {
        return "postgres-backup";
      } else if (options.cmd?.some(cmd => cmd.includes("pg_restore") || cmd.includes("psql"))) {
        return "postgres-restore";
      }
      return "postgres-task";
    }

    if (options.image.includes("mongo")) {
      return "mongodb-task";
    }

    if (options.image.includes("redis")) {
      return "redis-task";
    }

    if (options.serviceName?.includes("backup") || options.cmd?.some(cmd => cmd.includes("backup"))) {
      return "backup";
    }

    if (options.serviceName?.includes("restore") || options.cmd?.some(cmd => cmd.includes("restore"))) {
      return "restore";
    }

    return "utility";
  }

  /**
   * Generate a unique task ID for tracking
   */
  private generateTaskId(options: ContainerExecutionOptions): string {
    const timestamp = Date.now();
    const imageShort = options.image.split("/").pop()?.split(":")[0] || "unknown";
    return `${imageShort}-${timestamp}`;
  }

  /**
   * Find all containers belonging to a compose project
   */
  public async getProjectContainers(projectName: string): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['com.docker.compose.project'] === projectName
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          projectName,
        },
        "Failed to get project containers",
      );
      throw error;
    }
  }

  /**
   * Find containers by service name within a project
   */
  public async getServiceContainers(projectName: string, serviceName: string): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['com.docker.compose.project'] === projectName &&
        container.Labels['com.docker.compose.service'] === serviceName
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          projectName,
          serviceName,
        },
        "Failed to get service containers",
      );
      throw error;
    }
  }

  /**
   * Find all containers managed by mini-infra
   */
  public async getManagedContainers(): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['mini-infra.managed'] === 'true'
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get managed containers",
      );
      throw error;
    }
  }

  /**
   * Stop all containers in a compose project
   */
  public async stopProject(projectName: string): Promise<void> {
    const log = servicesLogger().child({ operation: 'stop-project', project: projectName });

    try {
      const containers = await this.getProjectContainers(projectName);

      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          const info = await container.inspect();

          if (info.State.Running) {
            await container.stop();
            log.info({ container: containerInfo.Names[0] }, 'Stopped container');
          }
        } catch (error) {
          log.error({ error, container: containerInfo.Names[0] }, 'Failed to stop container');
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to stop project');
      throw error;
    }
  }

  /**
   * Remove all containers in a compose project
   */
  public async removeProject(projectName: string): Promise<void> {
    const log = servicesLogger().child({ operation: 'remove-project', project: projectName });

    try {
      const containers = await this.getProjectContainers(projectName);

      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          const info = await container.inspect();

          if (info.State.Running) {
            await container.stop();
          }

          await container.remove();
          log.info({ container: containerInfo.Names[0] }, 'Removed container');
        } catch (error) {
          log.error({ error, container: containerInfo.Names[0] }, 'Failed to remove container');
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to remove project');
      throw error;
    }
  }

  /**
   * Create a Docker network with compose-style labels
   * Note: networkName should already be prefixed with environment name
   */
  public async createNetwork(
    networkName: string,
    projectName?: string,
    options?: { driver?: string; labels?: Record<string, string> }
  ): Promise<void> {
    try {
      const networks = await this.docker.listNetworks();
      const existingNetwork = networks.find(net => net.Name === networkName);

      if (!existingNetwork) {
        const labels: Record<string, string> = {
          'mini-infra.managed': 'true',
        };

        if (projectName) {
          labels['com.docker.compose.project'] = projectName;
          labels['com.docker.compose.network'] = networkName;
          labels['mini-infra.project'] = projectName;
        }

        if (options?.labels) {
          Object.assign(labels, options.labels);
        }

        await this.docker.createNetwork({
          Name: networkName,
          Driver: options?.driver || 'bridge',
          Labels: labels
        });

        servicesLogger().info({ network: networkName, project: projectName }, 'Created network');
      } else {
        servicesLogger().info({ network: networkName }, 'Network already exists');
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          network: networkName,
          project: projectName,
        },
        "Failed to create network",
      );
      throw error;
    }
  }

  /**
   * Create a Docker volume with compose-style labels
   * Note: volumeName should already be prefixed with environment name
   */
  public async createVolume(
    volumeName: string,
    projectName?: string,
    options?: { labels?: Record<string, string> }
  ): Promise<void> {
    try {
      const existingVolumes = await this.docker.listVolumes();
      const volumeExists = existingVolumes.Volumes?.some(vol => vol.Name === volumeName);

      if (!volumeExists) {
        const labels: Record<string, string> = {
          'mini-infra.managed': 'true',
        };

        if (projectName) {
          labels['com.docker.compose.project'] = projectName;
          labels['com.docker.compose.volume'] = volumeName;
          labels['mini-infra.project'] = projectName;
        }

        if (options?.labels) {
          Object.assign(labels, options.labels);
        }

        await this.docker.createVolume({
          Name: volumeName,
          Labels: labels
        });

        servicesLogger().info({ volume: volumeName, project: projectName }, 'Created volume');
      } else {
        servicesLogger().info({ volume: volumeName }, 'Volume already exists');
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volume: volumeName,
          project: projectName,
        },
        "Failed to create volume",
      );
      throw error;
    }
  }

  /**
   * Create a long-running container with compose-style labels
   * Unlike executeContainer, this creates but doesn't auto-remove the container
   */
  public async createLongRunningContainer(
    options: ContainerExecutionOptions & {
      name?: string;
      ports?: Record<string, { HostPort: string }[]>;
      volumes?: string[];
      mounts?: Array<{
        Target: string;
        Source: string;
        Type: 'volume' | 'bind';
        ReadOnly?: boolean;
      }>;
      networks?: string[];
      restartPolicy?: 'no' | 'on-failure' | 'unless-stopped' | 'always';
      healthcheck?: {
        Test: string[];
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
      };
      logConfig?: {
        Type: string;
        Config: Record<string, string>;
      };
    }
  ): Promise<Container> {
    try {
      servicesLogger().info(
        {
          image: options.image,
          name: options.name,
          projectName: options.projectName,
          serviceName: options.serviceName,
        },
        "Creating long-running container"
      );

      // Convert environment variables to Docker format
      const env = Object.entries(options.env).map(
        ([key, value]) => `${key}=${value}`,
      );

      const containerOptions: any = {
        Image: options.image,
        name: options.name,
        Env: env,
        Labels: this.labelManager.generateTaskExecutionLabels({
          projectName: options.projectName,
          serviceName: options.serviceName,
          containerPurpose: "utility",
          isTemporary: false, // Long-running containers are not temporary
          taskType: "long-running-service",
          taskId: options.name || this.generateTaskId(options),
          customLabels: options.labels,
        }),
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {},
      };

      // Add custom command if provided
      if (options.cmd) {
        containerOptions.Cmd = options.cmd;
      }

      // Add network mode if provided
      if (options.networkMode) {
        containerOptions.HostConfig.NetworkMode = options.networkMode;
      }

      // Add port bindings - need both ExposedPorts and PortBindings
      if (options.ports) {
        // First expose the ports at container level
        containerOptions.ExposedPorts = {};
        for (const port of Object.keys(options.ports)) {
          containerOptions.ExposedPorts[port] = {};
        }
        // Then bind them to host ports
        containerOptions.HostConfig.PortBindings = options.ports;
      }

      // Add bind mounts
      if (options.volumes) {
        containerOptions.HostConfig.Binds = options.volumes;
      }

      // Add volume mounts
      if (options.mounts) {
        containerOptions.HostConfig.Mounts = options.mounts;
      }

      // Add restart policy
      if (options.restartPolicy) {
        containerOptions.HostConfig.RestartPolicy = {
          Name: options.restartPolicy
        };
      }

      // Add logging configuration
      if (options.logConfig) {
        containerOptions.HostConfig.LogConfig = options.logConfig;
      }

      // Add health check
      if (options.healthcheck) {
        containerOptions.Healthcheck = {
          Test: options.healthcheck.Test,
          Interval: options.healthcheck.Interval || 30000000000, // 30s in nanoseconds
          Timeout: options.healthcheck.Timeout || 5000000000,   // 5s in nanoseconds
          Retries: options.healthcheck.Retries || 3,
          StartPeriod: options.healthcheck.StartPeriod || 10000000000 // 10s in nanoseconds
        };
      }

      // Set up networking
      if (options.networks && options.networks.length > 0) {
        containerOptions.NetworkingConfig = {
          EndpointsConfig: {}
        };
        for (const network of options.networks) {
          containerOptions.NetworkingConfig.EndpointsConfig[network] = {};
        }
      }

      const container = await this.docker.createContainer(containerOptions);

      servicesLogger().info(
        {
          containerId: container.id,
          name: options.name,
          projectName: options.projectName,
          serviceName: options.serviceName,
        },
        "Long-running container created successfully"
      );

      return container;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          image: options.image,
          name: options.name,
        },
        "Failed to create long-running container"
      );
      throw error;
    }
  }

  /**
   * Check if a Docker network exists
   */
  public async networkExists(networkName: string): Promise<boolean> {
    try {
      const networks = await this.docker.listNetworks();
      return networks.some(network => network.Name === networkName);
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          networkName,
        },
        "Failed to check if network exists"
      );
      return false;
    }
  }

  /**
   * Check if a Docker volume exists
   */
  public async volumeExists(volumeName: string): Promise<boolean> {
    try {
      const volumes = await this.docker.listVolumes();
      return volumes.Volumes?.some(volume => volume.Name === volumeName) || false;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to check if volume exists"
      );
      return false;
    }
  }

  /**
   * Remove a Docker volume
   */
  public async removeVolume(volumeName: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(volumeName);
      await volume.remove();
      servicesLogger().info({ volumeName }, 'Docker volume removed successfully');
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to remove Docker volume"
      );
      throw error;
    }
  }

  /**
   * Remove a Docker network
   */
  public async removeNetwork(networkName: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
      servicesLogger().info({ networkName }, 'Docker network removed successfully');
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          networkName,
        },
        "Failed to remove Docker network"
      );
      throw error;
    }
  }

  /**
   * Capture logs from a container (both stdout and stderr)
   */
  public async captureContainerLogs(
    containerId: string,
    options?: {
      tail?: number;
      since?: string;
      includeTimestamps?: boolean;
    }
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const container = this.docker.getContainer(containerId);

      const logOptions = {
        follow: true as const, // Need to follow to get a stream
        stdout: true,
        stderr: true,
        timestamps: options?.includeTimestamps || false,
        tail: options?.tail || 100, // Default to last 100 lines
        since: options?.since
      };

      const stream = await container.logs(logOptions) as any;

      return new Promise((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const timeout = setTimeout(() => {
          reject(new Error('Log capture timeout'));
        }, 30000); // 30 second timeout

        // Docker multiplexes stdout and stderr in a single stream
        // Each chunk has an 8-byte header: [stream_type, 0, 0, 0, size_bytes...]
        stream.on("data", (chunk: Buffer) => {
          if (chunk.length < 8) return;

          const streamType = chunk.readUInt8(0);
          const size = chunk.readUInt32BE(4);
          const data = chunk.subarray(8, 8 + size);

          if (streamType === 1) {
            stdoutChunks.push(data);
          } else if (streamType === 2) {
            stderrChunks.push(data);
          }
        });

        stream.on("end", () => {
          clearTimeout(timeout);
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8')
          });
        });

        stream.on("error", (error: any) => {
          clearTimeout(timeout);
          reject(error);
        });

        // For containers that have already exited, the stream might end immediately
        // Set a small delay to allow data to be emitted before ending
        setTimeout(() => {
          if (stream.readable && typeof stream.destroy === 'function') {
            stream.destroy();
          }
        }, 1000);
      });
    } catch (error) {
      dockerExecutorLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerId,
        },
        "Failed to capture container logs"
      );
      throw error;
    }
  }

  /**
   * Get the Docker client instance for advanced operations
   */
  public getDockerClient(): Docker {
    return this.docker;
  }
}
