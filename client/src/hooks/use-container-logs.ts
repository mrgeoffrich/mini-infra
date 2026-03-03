import { useState, useEffect, useCallback, useRef } from "react";
import { ContainerLogLine, ContainerLogEvent, ContainerLogOptions } from "@mini-infra/types/containers";

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
    maxLines = 5000,
    tail = 100,
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
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clear = useCallback(() => {
    setLogs([]);
    setError(null);
  }, []);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const connect = useCallback(() => {
    // Disconnect any existing connection
    disconnect();

    // Build query parameters
    const params = new URLSearchParams({
      tail: tail.toString(),
      follow: follow.toString(),
      timestamps: timestamps.toString(),
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    });

    if (since) params.set("since", since);
    if (until) params.set("until", until);

    // Create EventSource for SSE
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
            // Keep only the last maxLines entries (circular buffer)
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

      // Attempt to reconnect after 3 seconds
      if (follow) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
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
    disconnect,
  ]);

  const reconnect = useCallback(() => {
    clear();
    connect();
  }, [clear, connect]);

  // Connect/disconnect based on enabled flag
  useEffect(() => {
    if (enabled && containerId) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [enabled, containerId, connect, disconnect]);

  return {
    logs,
    isConnected,
    error,
    clear,
    reconnect,
    disconnect,
  };
}
