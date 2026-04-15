import Docker from "dockerode";
import { DEFAULT_LOG_TAIL_LINES } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { DockerStreamDemuxer } from "../../lib/docker-stream";

/**
 * ContainerMonitor - Monitors container status and captures logs
 */
export class ContainerMonitor {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
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
      getLogger("docker", "container-monitor").error(
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
        getLogger("docker", "container-monitor").info({ containerId }, "Container killed");
      } else {
        await container.stop();
        getLogger("docker", "container-monitor").info({ containerId }, "Container stopped");
      }
    } catch (error) {
      getLogger("docker", "container-monitor").error(
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
        tail: options?.tail || DEFAULT_LOG_TAIL_LINES,
        since: options?.since
      };

      const stream = await container.logs(logOptions) as NodeJS.ReadableStream & { destroy: () => void };

      return new Promise((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const timeout = setTimeout(() => {
          reject(new Error('Log capture timeout'));
        }, 30000); // 30 second timeout

        const demuxer = new DockerStreamDemuxer();

        stream.on("data", (chunk: Buffer) => {
          const frames = demuxer.push(chunk);
          for (const frame of frames) {
            if (frame.stream === "stdout") {
              stdoutChunks.push(frame.data);
            } else if (frame.stream === "stderr") {
              stderrChunks.push(frame.data);
            }
          }
        });

        stream.on("end", () => {
          clearTimeout(timeout);
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8')
          });
        });

        stream.on("error", (error: Error) => {
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
      getLogger("docker", "container-monitor").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          containerId,
        },
        "Failed to capture container logs"
      );
      throw error;
    }
  }
}
