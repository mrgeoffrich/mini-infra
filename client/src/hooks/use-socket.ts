/**
 * Socket.IO client hook for real-time server push events.
 *
 * Provides:
 * - useSocket()        — access the shared socket instance and connection status
 * - useSocketEvent()   — subscribe to a typed server event and bridge it into TanStack Query cache
 * - useSocketChannel() — auto-subscribe/unsubscribe to a room on mount/unmount
 */

import {
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { io, Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketChannel,
} from "@mini-infra/types";
import { ClientEvent, SOCKET_TRANSPORTS } from "@mini-infra/types";

// Fully typed client socket
type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// ====================
// Singleton socket instance
// ====================

let socket: TypedSocket | null = null;
let connectionAttempted = false;

// Reference counter for channel subscriptions — prevents premature
// UNSUBSCRIBE when multiple components share the same channel.
const channelRefCounts = new Map<string, number>();

function getSocket(): TypedSocket {
  if (!socket) {
    socket = io({
      // Connect to same origin (Vite proxies in dev, same host in prod)
      withCredentials: true,
      transports: [...SOCKET_TRANSPORTS],
      autoConnect: false,
    }) as TypedSocket;
  }
  return socket;
}

/**
 * useSyncExternalStore-based subscription to the socket's connected flag.
 * This is the idiomatic way to mirror external mutable state into React
 * without set-state-in-effect.
 */
function useSocketConnected(socketInstance: TypedSocket): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      socketInstance.on("connect", onChange);
      socketInstance.on("disconnect", onChange);
      return () => {
        socketInstance.off("connect", onChange);
        socketInstance.off("disconnect", onChange);
      };
    },
    [socketInstance],
  );
  const getSnapshot = useCallback(
    () => socketInstance.connected,
    [socketInstance],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ====================
// useSocket — connection lifecycle
// ====================

export interface UseSocketReturn {
  /** The typed socket instance */
  socket: TypedSocket;
  /** Whether the socket is currently connected */
  connected: boolean;
  /** Connect the socket (called automatically by SocketProvider, but available for manual reconnect) */
  connect: () => void;
  /** Disconnect the socket */
  disconnect: () => void;
}

/**
 * Access the shared socket instance and connection status.
 * The socket connects automatically on first use and disconnects
 * when no components are using it.
 */
export function useSocket(): UseSocketReturn {
  const socketInstance = useMemo(() => getSocket(), []);
  const connected = useSocketConnected(socketInstance);

  useEffect(() => {
    // Auto-connect on first mount. Kept as a mount-only side effect.
    if (!connectionAttempted) {
      connectionAttempted = true;
      socketInstance.connect();
    }
  }, [socketInstance]);

  const connect = useCallback(() => {
    if (!socketInstance.connected) {
      socketInstance.connect();
    }
  }, [socketInstance]);

  const disconnect = useCallback(() => {
    socketInstance.disconnect();
    connectionAttempted = false;
  }, [socketInstance]);

  return { socket: socketInstance, connected, connect, disconnect };
}

// ====================
// useSocketEvent — subscribe to a typed event
// ====================

/**
 * Subscribe to a server-to-client socket event.
 * The handler is called whenever the event fires while the component is mounted.
 *
 * @example
 * ```ts
 * useSocketEvent('containers:list', (data) => {
 *   queryClient.setQueryData(['containers'], data);
 * });
 * ```
 */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
  enabled: boolean = true,
): void {
  const socketInstance = useMemo(() => getSocket(), []);
  const handlerRef = useRef(handler);

  // Keep handler ref current without re-subscribing
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;

    const listener = ((...args: unknown[]) => {
      (handlerRef.current as (...a: unknown[]) => void)(...args);
    }) as ServerToClientEvents[E];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socketInstance.on(event as any, listener as any);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socketInstance.off(event as any, listener as any);
    };
  }, [socketInstance, event, enabled]);
}

// ====================
// useSocketChannel — room subscription lifecycle
// ====================

/**
 * Subscribe to a Socket.IO room/channel on mount, unsubscribe on unmount.
 * Use this in page components to scope which events the server sends.
 *
 * @example
 * ```ts
 * // In a deployment detail page:
 * useSocketChannel(`deployment:${deploymentId}`);
 *
 * // Now this component will receive 'deployment:status' events
 * // for this specific deployment
 * ```
 */
export function useSocketChannel(
  channel: SocketChannel | null | undefined,
  enabled: boolean = true,
): void {
  const socketInstance = useMemo(() => getSocket(), []);
  // Track connection state via useSyncExternalStore — avoids set-state-in-effect.
  const connected = useSocketConnected(socketInstance);

  useEffect(() => {
    if (!channel || !enabled || !connected) return;

    const count = channelRefCounts.get(channel) ?? 0;
    channelRefCounts.set(channel, count + 1);

    // Only emit SUBSCRIBE on first reference
    if (count === 0) {
      socketInstance.emit(ClientEvent.SUBSCRIBE, channel);
    }

    return () => {
      const current = channelRefCounts.get(channel) ?? 1;
      const next = current - 1;
      if (next <= 0) {
        channelRefCounts.delete(channel);
        socketInstance.emit(ClientEvent.UNSUBSCRIBE, channel);
      } else {
        channelRefCounts.set(channel, next);
      }
    };
  }, [socketInstance, channel, enabled, connected]);
}

// ====================
// useSocketQueryBridge — convenience for updating TanStack Query cache
// ====================

/**
 * Subscribe to a socket event and automatically update TanStack Query cache.
 *
 * @example
 * ```ts
 * // Automatically update the containers query when server pushes new data
 * useSocketQueryBridge('containers:list', ['containers'], (data) => data);
 * ```
 */
export function useSocketQueryBridge<
  E extends keyof ServerToClientEvents,
  TData = unknown,
>(
  event: E,
  queryKey: unknown[],
  transform: (
    ...args: Parameters<ServerToClientEvents[E]>
  ) => TData,
  enabled: boolean = true,
): void {
  const queryClient = useQueryClient();

  useSocketEvent(
    event,
    ((...args: unknown[]) => {
      const data = (transform as (...a: unknown[]) => TData)(...args);
      queryClient.setQueryData(queryKey, data);
    }) as ServerToClientEvents[E],
    enabled,
  );
}
