/**
 * Container Log Streamer
 *
 * Manages active Docker log streams per socket connection.
 * When a client emits `container:logs:start`, this service starts a Docker log
 * stream and forwards lines to the client via Socket.IO events.
 * When the client emits `container:logs:stop` or disconnects, the stream is cleaned up.
 */

import { Readable } from "stream";
import DockerService from "./docker";
import { DockerStreamDemuxer } from "../lib/docker-stream";
import { ServerEvent, DEFAULT_LOG_TAIL_LINES } from "@mini-infra/types";
import type { ContainerLogLine } from "@mini-infra/types/containers";
import type { TypedSocket } from "../lib/socket";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

/** Key for active stream map: socketId:containerId */
type StreamKey = string;

function makeKey(socketId: string, containerId: string): StreamKey {
  return `${socketId}:${containerId}`;
}

/** Active Docker log streams indexed by socket+container */
const activeStreams = new Map<StreamKey, Readable>();

/**
 * Start streaming container logs to a socket.
 */
export async function startLogStream(
  socket: TypedSocket,
  containerId: string,
  options: { tail?: number; timestamps?: boolean } = {},
): Promise<void> {
  const key = makeKey(socket.id, containerId);

  // If already streaming this container for this socket, stop the old one first
  stopLogStream(socket.id, containerId);

  try {
    const dockerService = DockerService.getInstance();

    if (!dockerService.isConnected()) {
      socket.emit(ServerEvent.CONTAINER_LOG_ERROR, {
        containerId,
        error: "Docker service is not available",
      });
      return;
    }

    const container = await dockerService.getContainer(containerId);
    if (!container) {
      socket.emit(ServerEvent.CONTAINER_LOG_ERROR, {
        containerId,
        error: `Container '${containerId}' not found`,
      });
      return;
    }

    const docker = await dockerService.getDockerInstance();
    const dockerContainer = docker.getContainer(containerId);

    const tail = options.tail ?? DEFAULT_LOG_TAIL_LINES;
    const timestamps = options.timestamps ?? true;

    const logStream: Readable = (await dockerContainer.logs({
      follow: true as const,
      stdout: true,
      stderr: true,
      tail,
      timestamps,
    })) as unknown as Readable;

    activeStreams.set(key, logStream);

    const demuxer = new DockerStreamDemuxer();

    logStream.on("data", (chunk: Buffer) => {
      for (const frame of demuxer.push(chunk)) {
        const message = frame.data.toString("utf-8").trimEnd();

        let timestamp: string | undefined;
        let logMessage = message;

        if (timestamps && message.match(/^\d{4}-\d{2}-\d{2}T/)) {
          const spaceIndex = message.indexOf(" ");
          if (spaceIndex > 0) {
            timestamp = message.substring(0, spaceIndex);
            logMessage = message.substring(spaceIndex + 1);
          }
        }

        const line: ContainerLogLine = {
          timestamp,
          message: logMessage,
          stream: frame.stream === "stderr" ? "stderr" : "stdout",
        };

        socket.emit(ServerEvent.CONTAINER_LOG, {
          containerId,
          line,
        });
      }
    });

    logStream.on("end", () => {
      activeStreams.delete(key);
      socket.emit(ServerEvent.CONTAINER_LOG_END, { containerId });

      logger.debug(
        { socketId: socket.id, containerId },
        "Container log stream ended",
      );
    });

    logStream.on("error", (error: Error) => {
      activeStreams.delete(key);
      socket.emit(ServerEvent.CONTAINER_LOG_ERROR, {
        containerId,
        error: (error instanceof Error ? error.message : String(error)),
      });

      logger.error(
        { error: (error instanceof Error ? error.message : String(error)), socketId: socket.id, containerId },
        "Container log stream error",
      );
    });

    logger.debug(
      { socketId: socket.id, containerId, tail, timestamps },
      "Container log stream started",
    );
  } catch (error) {
    activeStreams.delete(key);
    socket.emit(ServerEvent.CONTAINER_LOG_ERROR, {
      containerId,
      error: error instanceof Error ? error.message : "Failed to start log stream",
    });

    logger.error(
      { error: error instanceof Error ? error.message : error, socketId: socket.id, containerId },
      "Failed to start container log stream",
    );
  }
}

/**
 * Stop streaming container logs for a specific socket+container.
 */
export function stopLogStream(socketId: string, containerId: string): void {
  const key = makeKey(socketId, containerId);
  const stream = activeStreams.get(key);
  if (stream) {
    stream.destroy();
    activeStreams.delete(key);
    logger.debug({ socketId, containerId }, "Container log stream stopped");
  }
}

/**
 * Stop all log streams for a socket (called on disconnect).
 */
export function cleanupSocketStreams(socketId: string): void {
  const prefix = `${socketId}:`;
  for (const [key, stream] of activeStreams.entries()) {
    if (key.startsWith(prefix)) {
      stream.destroy();
      activeStreams.delete(key);
    }
  }
  logger.debug({ socketId }, "Cleaned up all log streams for socket");
}
