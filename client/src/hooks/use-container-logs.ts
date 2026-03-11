import { useState, useEffect, useCallback, useRef } from "react";
import { ContainerLogLine, ContainerLogEvent, ContainerLogOptions } from "@mini-infra/types/containers";
import { DEFAULT_LOG_TAIL_LINES, MAX_LOG_TAIL_LINES, ClientEvent, ServerEvent } from "@mini-infra/types";
import { useSocket } from "./use-socket";

interface UseContainerLogsOptions extends ContainerLogOptions {
  containerId: string;
  enabled?: boolean;
  maxLines?: number; // Maximum number of lines to keep in buffer (default: 5000)
}

interface UseContainerLogsResult {
  logs: ContainerLogLine[];
  isConnected: boolean;
  error: string | null;
  clear: () => void;
  reconnect: () => void;
  disconnect: () => void;
}

export function useContainerLogs(options: UseContainerLogsOptions): UseContainerLogsResult {
  const {
    containerId,
    enabled = true,
    maxLines = MAX_LOG_TAIL_LINES,
    tail = DEFAULT_LOG_TAIL_LINES,
    follow = true,
    timestamps = true,
    stdout = true,
    stderr = true,
    since,
    until,
  } = options;

  const [logs, setLogs] = useState<ContainerLogLine[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { socket, connected: socketConnected } = useSocket();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const usingSocketRef = useRef(false);

  const clear = useCallback(() => {
    setLogs([]);
    setError(null);
  }, []);

  const disconnectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const disconnectSocket = useCallback(() => {
    if (usingSocketRef.current && containerId) {
      socket.emit(ClientEvent.CONTAINER_LOGS_STOP, { containerId });
      usingSocketRef.current = false;
    }
  }, [socket, containerId]);

  const disconnect = useCallback(() => {
    disconnectSocket();
    disconnectSSE();
    setIsConnected(false);
  }, [disconnectSocket, disconnectSSE]);

  // SSE fallback connection
  const connectSSE = useCallback(() => {
    disconnectSSE();

    const params = new URLSearchParams({
      tail: tail.toString(),
      follow: follow.toString(),
      timestamps: timestamps.toString(),
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    });

    if (since) params.set("since", since);
    if (until) params.set("until", until);

    const url = `/api/containers/${containerId}/logs/stream?${params.toString()}`;
    const eventSource = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        const logEvent: ContainerLogEvent = JSON.parse(event.data);

        if (logEvent.type === "log" && logEvent.data) {
          setLogs((prevLogs) => {
            const newLogs = [...prevLogs, logEvent.data!];
            if (newLogs.length > maxLines) {
              return newLogs.slice(newLogs.length - maxLines);
            }
            return newLogs;
          });
        } else if (logEvent.type === "error") {
          setError(logEvent.error || "Unknown error occurred");
          setIsConnected(false);
        } else if (logEvent.type === "end") {
          setIsConnected(false);
          eventSource.close();
        }
      } catch (err) {
        console.error("Failed to parse log event:", err);
        setError("Failed to parse log event");
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      setError("Connection lost. Attempting to reconnect...");
      eventSource.close();

      if (follow) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connectSSE();
        }, 3000);
      }
    };
  }, [
    containerId,
    tail,
    follow,
    timestamps,
    stdout,
    stderr,
    since,
    until,
    maxLines,
    disconnectSSE,
  ]);

  // Socket.IO connection
  const connectViaSocket = useCallback(() => {
    disconnectSSE();
    usingSocketRef.current = true;
    setIsConnected(true);
    setError(null);

    socket.emit(ClientEvent.CONTAINER_LOGS_START, {
      containerId,
      tail,
      timestamps,
    });
  }, [socket, containerId, tail, timestamps, disconnectSSE]);

  // Listen for Socket.IO log events
  useEffect(() => {
    if (!enabled || !containerId || !socketConnected) return;

    const handleLog = (data: { containerId: string; line: ContainerLogLine }) => {
      if (data.containerId !== containerId) return;
      setLogs((prevLogs) => {
        const newLogs = [...prevLogs, data.line];
        if (newLogs.length > maxLines) {
          return newLogs.slice(newLogs.length - maxLines);
        }
        return newLogs;
      });
    };

    const handleEnd = (data: { containerId: string }) => {
      if (data.containerId !== containerId) return;
      setIsConnected(false);
      usingSocketRef.current = false;
    };

    const handleError = (data: { containerId: string; error: string }) => {
      if (data.containerId !== containerId) return;
      setError(data.error);
      setIsConnected(false);
      usingSocketRef.current = false;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on(ServerEvent.CONTAINER_LOG as any, handleLog as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on(ServerEvent.CONTAINER_LOG_END as any, handleEnd as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on(ServerEvent.CONTAINER_LOG_ERROR as any, handleError as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.off(ServerEvent.CONTAINER_LOG as any, handleLog as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.off(ServerEvent.CONTAINER_LOG_END as any, handleEnd as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.off(ServerEvent.CONTAINER_LOG_ERROR as any, handleError as any);
    };
  }, [enabled, containerId, socketConnected, socket, maxLines]);

  // Connect/disconnect based on enabled flag and socket availability
  useEffect(() => {
    if (enabled && containerId) {
      if (socketConnected) {
        connectViaSocket();
      } else {
        connectSSE();
      }
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, containerId, socketConnected]);

  const reconnect = useCallback(() => {
    clear();
    if (socketConnected) {
      connectViaSocket();
    } else {
      connectSSE();
    }
  }, [clear, socketConnected, connectViaSocket, connectSSE]);

  return {
    logs,
    isConnected,
    error,
    clear,
    reconnect,
    disconnect,
  };
}
