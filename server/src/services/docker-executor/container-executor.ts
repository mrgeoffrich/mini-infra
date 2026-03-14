import Docker, { Container } from "dockerode";
import { Readable } from "stream";
import { servicesLogger, dockerExecutorLogger } from "../../lib/logger-factory";
import ContainerLabelManager from "../container/container-label-manager";
import type { ContainerExecutionOptions, ContainerExecutionResult, ContainerProgress } from "./types";
import { inferTaskType, generateTaskId } from "./utils";
import { DockerStreamDemuxer } from "../../lib/docker-stream";

/**
 * ContainerExecutor - Executes short-lived, task-specific Docker containers
 */
export class ContainerExecutor {
  private docker: Docker;
  private labelManager: ContainerLabelManager;
  private static readonly DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  constructor(docker: Docker, labelManager: ContainerLabelManager) {
    this.docker = docker;
    this.labelManager = labelManager;
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
          timeout: options.timeout || ContainerExecutor.DEFAULT_TIMEOUT,
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
            timeout: options.timeout || ContainerExecutor.DEFAULT_TIMEOUT,
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
            timeout: options.timeout || ContainerExecutor.DEFAULT_TIMEOUT,
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
        options.timeout || ContainerExecutor.DEFAULT_TIMEOUT,
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
          taskType: inferTaskType(options),
          taskId: generateTaskId(options),
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

      // Demultiplex Docker stream using buffered parser to handle
      // chunks that contain multiple or partial frames
      const stdout = new Readable({ read() { } });
      const stderr = new Readable({ read() { } });
      const demuxer = new DockerStreamDemuxer();

      stream.on("data", (chunk: Buffer) => {
        const frames = demuxer.push(chunk);
        for (const frame of frames) {
          if (frame.stream === "stdout") {
            stdout.push(frame.data);
          } else if (frame.stream === "stderr") {
            stderr.push(frame.data);
          }
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
}
