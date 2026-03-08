/**
 * Socket.IO Server Setup
 *
 * Initializes and configures the Socket.IO server with:
 * - TypeScript type safety via shared event definitions
 * - JWT and API key authentication middleware
 * - Room-based channel subscriptions
 * - Graceful connection/disconnection handling
 */

import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  SocketChannel,
} from "@mini-infra/types";
import { isValidSocketChannel, isValidContainerId, ClientEvent, ParameterizedChannel, MAX_SOCKET_SUBSCRIPTIONS, SOCKET_TRANSPORTS } from "@mini-infra/types";
import { verifyToken, extractTokenFromHeader, extractTokenFromCookie } from "./jwt";
import { validateApiKey } from "./api-key-service";
import { appLogger } from "./logger-factory";
import appConfig, { corsOrigin } from "./config-new";

const logger = appLogger();

/** Fully typed Socket.IO server instance */
export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Fully typed Socket.IO socket instance */
export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// Singleton server instance
let io: TypedServer | null = null;

/**
 * Type-safe wrappers for socket.join/leave.
 * Socket.IO's join/leave accept raw strings — these ensure only valid
 * SocketChannel values are used.
 */
function joinChannel(socket: TypedSocket, channel: SocketChannel): void {
  socket.join(channel);
  socket.data.subscribedChannels.add(channel);
}

function leaveChannel(socket: TypedSocket, channel: SocketChannel): void {
  socket.leave(channel);
  socket.data.subscribedChannels.delete(channel);
}

/**
 * Initialize the Socket.IO server and attach it to the HTTP server.
 * Must be called once during server startup.
 */
export function initializeSocketIO(httpServer: HttpServer): TypedServer {
  if (io) {
    logger.warn("Socket.IO server already initialized, returning existing instance");
    return io;
  }

  io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    transports: [...SOCKET_TRANSPORTS],
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      if (!user) {
        return next(new Error("Authentication required"));
      }

      socket.data.userId = user.id;
      socket.data.userName = user.name;
      socket.data.subscribedChannels = new Set();

      logger.debug(
        { userId: user.id, socketId: socket.id },
        "Socket authenticated"
      );
      next();
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : err, socketId: socket.id },
        "Socket authentication failed"
      );
      next(new Error("Authentication failed"));
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    logger.info(
      { userId: socket.data.userId, socketId: socket.id },
      "Socket connected"
    );

    // Handle channel subscriptions
    socket.on(ClientEvent.SUBSCRIBE, (channel) => {
      if (!isValidSocketChannel(channel)) {
        logger.warn(
          { userId: socket.data.userId, socketId: socket.id, channel },
          "Socket attempted to subscribe to invalid channel"
        );
        return;
      }
      if (socket.data.subscribedChannels.size >= MAX_SOCKET_SUBSCRIPTIONS) {
        logger.warn(
          { userId: socket.data.userId, socketId: socket.id, channel, limit: MAX_SOCKET_SUBSCRIPTIONS },
          "Socket subscription limit reached"
        );
        return;
      }
      joinChannel(socket, channel);
      logger.debug(
        { userId: socket.data.userId, socketId: socket.id, channel },
        "Socket subscribed to channel"
      );
    });

    socket.on(ClientEvent.UNSUBSCRIBE, (channel) => {
      if (!isValidSocketChannel(channel)) {
        return;
      }
      leaveChannel(socket, channel);
      logger.debug(
        { userId: socket.data.userId, socketId: socket.id, channel },
        "Socket unsubscribed from channel"
      );
    });

    // Handle container log streaming
    socket.on(ClientEvent.CONTAINER_LOGS_START, (data) => {
      if (!isValidContainerId(data.containerId)) {
        logger.warn(
          { userId: socket.data.userId, socketId: socket.id, containerId: data.containerId },
          "Invalid container ID in log stream request"
        );
        return;
      }
      const channel = ParameterizedChannel.container(data.containerId);
      joinChannel(socket, channel);
      logger.debug(
        {
          userId: socket.data.userId,
          socketId: socket.id,
          containerId: data.containerId,
          tail: data.tail,
        },
        "Container log streaming requested"
      );
      // Actual log streaming will be handled by the container service
      // when it emits events to the container:{id} room
    });

    socket.on(ClientEvent.CONTAINER_LOGS_STOP, (data) => {
      if (!isValidContainerId(data.containerId)) {
        return;
      }
      const channel = ParameterizedChannel.container(data.containerId);
      leaveChannel(socket, channel);
      logger.debug(
        { userId: socket.data.userId, socketId: socket.id, containerId: data.containerId },
        "Container log streaming stopped"
      );
    });

    // Handle disconnection
    socket.on("disconnect", (reason) => {
      logger.info(
        {
          userId: socket.data.userId,
          socketId: socket.id,
          reason,
          channels: Array.from(socket.data.subscribedChannels),
        },
        "Socket disconnected"
      );
    });
  });

  logger.info("Socket.IO server initialized");
  return io;
}

/**
 * Get the Socket.IO server instance.
 * Returns null if not yet initialized.
 */
export function getIO(): TypedServer | null {
  return io;
}

/**
 * Get the Socket.IO server instance, throwing if not initialized.
 * Use this in service code that must have socket access.
 */
export function requireIO(): TypedServer {
  if (!io) {
    throw new Error("Socket.IO server not initialized. Call initializeSocketIO() first.");
  }
  return io;
}

/**
 * Emit an event to a specific channel (room).
 * Convenience wrapper that handles the case where Socket.IO isn't initialized.
 *
 * Type-safe at the call site: event name and payload are validated against
 * ServerToClientEvents. The internal cast is needed because Socket.IO's
 * BroadcastOperator decorates emit signatures with acknowledgement generics
 * that don't match our plain event definitions.
 */
export function emitToChannel<E extends keyof ServerToClientEvents>(
  channel: SocketChannel,
  event: E,
  data: Parameters<ServerToClientEvents[E]>[0],
): void {
  if (!io) {
    logger.debug(
      { channel, event: String(event) },
      "Socket.IO not initialized, skipping emit"
    );
    return;
  }

  // Cast needed: Socket.IO's BroadcastOperator wraps emit with acknowledgement
  // generics that are incompatible with our plain (data) => void signatures.
  // Type safety is enforced by this function's generic signature instead.
  (io.to(channel) as any).emit(event, data);
}

/**
 * Emit an event to all connected clients.
 */
export function emitToAll<E extends keyof ServerToClientEvents>(
  event: E,
  data: Parameters<ServerToClientEvents[E]>[0],
): void {
  if (!io) {
    return;
  }

  (io as any).emit(event, data);
}

/**
 * Shut down the Socket.IO server gracefully.
 */
export async function shutdownSocketIO(): Promise<void> {
  if (!io) return;

  return new Promise((resolve) => {
    io!.close(() => {
      logger.info("Socket.IO server shut down");
      io = null;
      resolve();
    });
  });
}

// ====================
// Authentication helpers
// ====================

interface SocketUser {
  id: string;
  name: string;
}

/**
 * Authenticate a socket connection using JWT token or API key.
 * Tokens can be provided via:
 * - auth.token in the handshake
 * - auth.apiKey in the handshake
 */
async function authenticateSocket(socket: TypedSocket): Promise<SocketUser | null> {
  const { auth, headers } = socket.handshake;

  // Try JWT token from auth handshake
  if (auth?.token) {
    try {
      const token = auth.token.startsWith("Bearer ")
        ? extractTokenFromHeader(auth.token)
        : auth.token;

      if (token) {
        const payload = verifyToken(token);
        return {
          id: payload.sub,
          name: payload.name || payload.email,
        };
      }
    } catch {
      // JWT failed, fall through
    }
  }

  // Try JWT from cookie (browser connections send cookies automatically)
  if (headers.cookie) {
    try {
      const cookies = parseCookies(headers.cookie);
      const token = extractTokenFromCookie(cookies);
      if (token) {
        const payload = verifyToken(token);
        return {
          id: payload.sub,
          name: payload.name || payload.email,
        };
      }
    } catch {
      // Cookie JWT failed, fall through
    }
  }

  // Try API key from auth handshake
  if (auth?.apiKey) {
    try {
      const result = await validateApiKey(auth.apiKey);
      if (result.valid && result.userId) {
        return {
          id: result.userId,
          name: result.user?.name || "API User",
        };
      }
    } catch {
      // API key validation failed
    }
  }

  return null;
}

/**
 * Parse a raw cookie header string into a key-value record.
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}
