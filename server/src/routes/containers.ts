import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { Readable } from "stream";
import DockerService from "../services/docker";
import { getLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";
import { createRouteDescriber } from "../lib/describe-route";

const logger = getLogger("docker", "containers");
import { getAuthenticatedUser } from "../middleware/auth";
import {
  ContainerInfo,
  ContainerQueryParams,
  ContainerListResponse,
  ContainerListApiResponse,
  ContainerLogOptions,
  ContainerLogEvent,
  ContainerAction,
  ContainerActionResponse,
  ContainerCacheResponse,
  ContainerCacheFlushResponse,
} from "@mini-infra/types/containers";

import { ApiBase, ApiRoute, ApiResponse, Channel, DEFAULT_LOG_TAIL_LINES, ServerEvent, isValidContainerId } from "@mini-infra/types";
import { serializeContainer, fetchAndSerializeContainers } from "../services/container-serializer";
import { emitToChannel } from "../lib/socket";
import { DockerStreamDemuxer } from "../lib/docker-stream";
import {
  ContainerQuerySchema,
  ContainerListApiResponseSchema,
  PostgresContainersResponseSchema,
  ManagedContainerIdsResponseSchema,
  ContainerIdParams,
  ContainerDetailResponseSchema,
  ContainerEnvResponseSchema,
  ContainerCacheStatsResponseSchema,
  ContainerCacheFlushResponseSchema,
  ContainerLogsQuerySchema,
  ContainerActionParams,
  ContainerActionResponseSchema,
} from "./containers.schemas";

const router = express.Router();
const describe = createRouteDescriber(router, ApiBase.containers);

/**
 * Derive this router's mount-relative path from an `ApiRoute.containers.*`
 * absolute builder, so the route registrations below and the registry in
 * `@mini-infra/types` can never drift apart. `ApiRoute.containers.*` returns
 * paths prefixed with `ApiBase.containers` (this router's mount point in
 * `app-factory.ts`); stripping that prefix recovers the Express-relative
 * pattern (e.g. `/:id/env`), falling back to `/` for the router root.
 */
function rel(absolute: string): string {
  return absolute.slice(ApiBase.containers.length) || "/";
}

describe(
  "get",
  rel(ApiRoute.containers.list()),
  {
    summary: "List containers",
    description:
      "Filterable, sortable, paginated list of Docker containers on the managed host.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects: "none — read-only, paginated list",
    request: { query: ContainerQuerySchema },
    response: ContainerListApiResponseSchema,
    errorResponses: [
      { status: 400, description: "Invalid query parameters" },
      { status: 503, description: "Docker service is not connected" },
      { status: 504, description: "Docker API request timed out" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
      query: req.query,
    },
    "Container list requested",
  );

  try {
    // Validate query parameters
    const queryValidation = ContainerQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for container list",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const queryParams: ContainerQueryParams = queryValidation.data;
    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Fetch containers from Docker service
    let containers = await fetchAndSerializeContainers(dockerService);

    // Apply filtering
    if (queryParams.status) {
      containers = containers.filter(
        (container) => container.status === queryParams.status,
      );
    }

    if (queryParams.name) {
      const nameFilter = queryParams.name.toLowerCase();
      containers = containers.filter((container) =>
        container.name.toLowerCase().includes(nameFilter),
      );
    }

    if (queryParams.image) {
      const imageFilter = queryParams.image.toLowerCase();
      containers = containers.filter((container) =>
        container.image.toLowerCase().includes(imageFilter),
      );
    }

    // Apply sorting
    containers.sort((a, b) => {
      const field = queryParams.sortBy || "name";
      const order = queryParams.sortOrder || "asc";

      let aValue: unknown = a[field as keyof typeof a];
      let bValue: unknown = b[field as keyof typeof b];

      // Handle date sorting
      if (aValue instanceof Date && bValue instanceof Date) {
        return order === "asc"
          ? aValue.getTime() - bValue.getTime()
          : bValue.getTime() - aValue.getTime();
      }

      // Handle string sorting
      if (typeof aValue === "string" && typeof bValue === "string") {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if ((aValue as string | number) < (bValue as string | number)) return order === "asc" ? -1 : 1;
      if ((aValue as string | number) > (bValue as string | number)) return order === "asc" ? 1 : -1;
      return 0;
    });

    const totalCount = containers.length;

    // Apply pagination
    const page = queryParams.page || 1;
    const limit = queryParams.limit || 50;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedContainers = containers.slice(startIndex, endIndex);

    const response: ContainerListResponse = {
      containers: paginatedContainers,
      totalCount,
      lastUpdated: new Date().toISOString(),
      page,
      limit,
    };

    logger.debug(
      {
        requestId,
        userId,
        totalContainers: totalCount,
        returnedContainers: paginatedContainers.length,
        page,
        limit,
        cacheStats: dockerService.getCacheStats(),
      },
      "Container list returned successfully",
    );

    // Log business event
    logger.debug(
      {
        event: "container_list_viewed",
        userId,
        requestId,
        containerCount: totalCount,
        filters: {
          status: queryParams.status,
          name: queryParams.name,
          image: queryParams.image,
        },
        sortBy: queryParams.sortBy,
        sortOrder: queryParams.sortOrder,
      },
      "Business event: container list viewed",
    );

    const apiResponse: ContainerListApiResponse = {
      success: true,
      data: response,
    };

    res.json(apiResponse);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        query: req.query,
      },
      "Failed to fetch container list",
    );

    // Check if it's a Docker connectivity error
    if (
      error instanceof Error &&
      (error instanceof Error ? error.message : String(error)).includes("Docker service not connected")
    ) {
      return res.status(503).json({
        error: "Service Unavailable",
        message:
          "Docker service is temporarily unavailable. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Handle timeout errors
    if (error instanceof Error && (error instanceof Error ? error.message : String(error)).includes("timeout")) {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
  }) as RequestHandler,
);


// Get PostgreSQL containers (detected by image and env vars)
describe(
  "get",
  rel(ApiRoute.containers.postgres()),
  {
    summary: "List PostgreSQL containers",
    description:
      "Containers detected as PostgreSQL by image name and environment variables.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects: "none — read-only Docker inspection",
    response: PostgresContainersResponseSchema,
    errorResponses: [
      { status: 503, description: "Docker service is not connected" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
    },
    "PostgreSQL containers requested",
  );

  try {
    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get detected PostgreSQL containers
    const dockerContainers = await dockerService.detectPostgresContainers();
    const containers = await Promise.all(dockerContainers.map(serializeContainer));

    logger.debug(
      {
        requestId,
        userId,
        containerCount: containers.length,
      },
      "PostgreSQL containers returned successfully",
    );

    const response: ApiResponse<ContainerInfo[]> = {
      success: true,
      data: containers,
    };
    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch PostgreSQL containers",
    );

    next(error);
  }
  }) as RequestHandler,
);

// Get managed container IDs (containers linked to PostgreSQL servers)
describe(
  "get",
  rel(ApiRoute.containers.managedIds()),
  {
    summary: "Get managed container IDs",
    description:
      "Maps container ID to PostgresServer ID for containers linked to a PostgreSQL server owned by the caller.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects: "none — read-only DB query",
    response: ManagedContainerIdsResponseSchema,
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
    },
    "Managed container IDs requested",
  );

  try {
    // Get all PostgreSQL servers with linked containers
    const servers = await prisma.postgresServer.findMany({
      where: {
        userId,
        linkedContainerId: {
          not: null,
        },
      },
      select: {
        id: true,
        linkedContainerId: true,
      },
    });

    // Create a mapping of container ID to server ID
    const managedContainerMap = servers
      .filter((s) => s.linkedContainerId !== null)
      .reduce((acc, s) => {
        acc[s.linkedContainerId!] = s.id;
        return acc;
      }, {} as Record<string, string>);

    logger.debug(
      {
        requestId,
        userId,
        count: Object.keys(managedContainerMap).length,
      },
      "Managed container IDs returned successfully",
    );

    const response: ApiResponse<Record<string, string>> = {
      success: true,
      data: managedContainerMap,
    };
    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch managed container IDs",
    );

    next(error);
  }
  }) as RequestHandler,
);

describe(
  "get",
  rel(ApiRoute.containers.get(":id")),
  {
    summary: "Get container details",
    description: "Fetches a single container by ID, enriched with environment/self-role metadata.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects: "none — read-only Docker inspection",
    request: { params: ContainerIdParams },
    response: ContainerDetailResponseSchema,
    errorResponses: [
      { status: 400, description: "Invalid container ID format" },
      { status: 404, description: "Container not found" },
      { status: 503, description: "Docker service is not connected" },
      { status: 504, description: "Docker API request timed out" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const containerId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      containerId,
    },
    "Container details requested",
  );

  try {
    // Validate container ID format
    if (!containerId || !isValidContainerId(containerId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid container ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
          containerId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerContainer = await dockerService.getContainer(containerId);

    if (!dockerContainer) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
        },
        "Container not found",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Container with ID '${containerId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.debug(
      {
        requestId,
        userId,
        containerId,
        containerName: dockerContainer.name,
        containerStatus: dockerContainer.status,
      },
      "Container details returned successfully",
    );

    const response: ContainerInfo = await serializeContainer(dockerContainer);
    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        containerId,
      },
      "Failed to fetch container details",
    );

    // Handle specific Docker API errors
    if (error instanceof Error && (error instanceof Error ? error.message : String(error)).includes("timeout")) {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
  }) as RequestHandler,
);

// Get container environment variables
describe(
  "get",
  rel(ApiRoute.containers.env(":id")),
  {
    summary: "Get container environment variables",
    description: "Fetches the environment variables of a running/stopped container.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects:
      "none — read-only; may expose secrets stored as container environment variables",
    request: { params: ContainerIdParams },
    response: ContainerEnvResponseSchema,
    errorResponses: [
      { status: 400, description: "Invalid container ID format" },
      { status: 404, description: "Container not found" },
      { status: 503, description: "Docker service is not connected" },
      { status: 504, description: "Docker API request timed out" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const containerId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      containerId,
    },
    "Container environment variables requested",
  );

  try {
    // Validate container ID format
    if (!containerId || !isValidContainerId(containerId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid container ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
          containerId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get environment variables
    const envVars = await dockerService.getContainerEnvironmentVariables(containerId);

    if (envVars === null) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
        },
        "Container not found for environment variables",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Container with ID '${containerId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    logger.debug(
      {
        requestId,
        userId,
        containerId,
        envVarCount: Object.keys(envVars).length,
      },
      "Container environment variables returned successfully",
    );

    const response: ApiResponse<Record<string, string>> = {
      success: true,
      data: envVars,
    };
    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        containerId,
      },
      "Failed to fetch container environment variables",
    );

    // Handle specific Docker API errors
    if (error instanceof Error && (error instanceof Error ? error.message : String(error)).includes("timeout")) {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Docker API request timed out. Please try again.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    next(error);
  }
  }) as RequestHandler,
);


describe(
  "get",
  rel(ApiRoute.containers.cacheStats()),
  {
    summary: "Get Docker service cache statistics",
    description: "In-memory cache hit/miss counters for the Docker service's container/network/volume cache.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects: "none — read-only in-memory cache stats",
    response: ContainerCacheStatsResponseSchema,
  },
  (async (
    req: Request,
    res: Response,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cache statistics requested",
  );

  const dockerService = DockerService.getInstance();
  const cacheStats = dockerService.getCacheStats();

  const response: ContainerCacheResponse = {
    cache: cacheStats,
    dockerConnected: dockerService.isConnected(),
    timestamp: new Date().toISOString(),
    requestId,
  };
  res.json(response);
  }) as RequestHandler,
);


describe(
  "post",
  rel(ApiRoute.containers.flushCache()),
  {
    summary: "Flush the Docker service cache",
    description: "Invalidates the in-process cache of container/network/volume lookups.",
    tags: ["Containers"],
    permission: "containers:write",
    sideEffects:
      "invalidates the in-process Docker object cache; forces the next read to hit the Docker API",
    response: ContainerCacheFlushResponseSchema,
  },
  (async (
    req: Request,
    res: Response,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;

  logger.debug(
    {
      requestId,
      userId,
    },
    "Container cache flush requested",
  );

  const dockerService = DockerService.getInstance();
  dockerService.flushCache();

  logger.debug(
    {
      requestId,
      userId,
    },
    "Container cache flushed successfully",
  );

  const response: ContainerCacheFlushResponse = {
    message: "Container cache flushed successfully",
    timestamp: new Date().toISOString(),
    requestId,
  };
  res.json(response);
  }) as RequestHandler,
);


// Container logs streaming endpoint (Server-Sent Events)
describe(
  "get",
  rel(ApiRoute.containers.logsStream(":id")),
  {
    summary: "Stream container logs (Server-Sent Events)",
    description:
      "Opens a long-lived SSE connection and tails the container's stdout/stderr in real time.",
    tags: ["Containers"],
    permission: "containers:read",
    sideEffects:
      "opens a long-lived SSE connection and tails the container's stdout/stderr",
    request: { params: ContainerIdParams, query: ContainerLogsQuerySchema },
    response: {
      contentType: "text/event-stream",
      description: "Server-Sent Events stream of ContainerLogEvent JSON payloads",
    },
    errorResponses: [
      { status: 400, description: "Invalid container ID or query parameters" },
      { status: 404, description: "Container not found" },
      { status: 503, description: "Docker service is not connected" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const containerId = String(req.params.id);

  logger.debug(
    {
      requestId,
      userId,
      containerId,
      query: req.query,
    },
    "Container log stream requested",
  );

  try {
    // Validate container ID
    if (!containerId || !isValidContainerId(containerId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid container ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate query parameters
    const queryValidation = ContainerLogsQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
          validationErrors: queryValidation.error.issues,
        },
        "Invalid query parameters for log stream",
      );

      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid query parameters",
        details: queryValidation.error.issues,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const options: ContainerLogOptions = queryValidation.data;
    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
          containerId,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Verify container exists
    const container = await dockerService.getContainer(containerId);
    if (!container) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
        },
        "Container not found for log streaming",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Container with ID '${containerId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Set up Server-Sent Events headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    // Send initial connection event
    const initialEvent: ContainerLogEvent = {
      type: "log",
      data: {
        timestamp: new Date().toISOString(),
        message: `Connected to log stream for container ${container.name}`,
        stream: "stdout",
      },
    };
    res.write(`data: ${JSON.stringify(initialEvent)}\n\n`);

    logger.info(
      {
        requestId,
        userId,
        containerId,
        containerName: container.name,
        options,
      },
      "Starting container log stream",
    );

    // Get the Docker container object
    const docker = await dockerService.getDockerInstance();
    const dockerContainer = docker.getContainer(containerId);

    // Start streaming logs
    const shouldFollow = options.follow ?? true;
    const logStream: Readable = (await dockerContainer.logs({
      follow: shouldFollow as true,
      stdout: options.stdout ?? true,
      stderr: options.stderr ?? true,
      tail: options.tail ?? DEFAULT_LOG_TAIL_LINES,
      timestamps: options.timestamps ?? false,
      since: options.since ? parseInt(options.since) : undefined,
      until: options.until ? parseInt(options.until) : undefined,
    })) as unknown as Readable;

    const demuxer = new DockerStreamDemuxer();

    logStream.on("data", (chunk: Buffer) => {
      for (const frame of demuxer.push(chunk)) {
        const message = frame.data.toString("utf-8").trimEnd();

        // Parse timestamp if present (Docker format: "2025-01-13T10:30:45.123456789Z message")
        let timestamp: string | undefined;
        let logMessage = message;

        if (options.timestamps && message.match(/^\d{4}-\d{2}-\d{2}T/)) {
          const spaceIndex = message.indexOf(' ');
          if (spaceIndex > 0) {
            timestamp = message.substring(0, spaceIndex);
            logMessage = message.substring(spaceIndex + 1);
          }
        }

        const event: ContainerLogEvent = {
          type: "log",
          data: {
            timestamp,
            message: logMessage,
            stream: frame.stream === "stderr" ? "stderr" : "stdout",
          },
        };

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });

    logStream.on("end", () => {
      logger.debug(
        {
          requestId,
          userId,
          containerId,
        },
        "Container log stream ended",
      );

      const endEvent: ContainerLogEvent = {
        type: "end",
      };
      res.write(`data: ${JSON.stringify(endEvent)}\n\n`);
      res.end();
    });

    logStream.on("error", (error: Error) => {
      logger.error(
        {
          error,
          requestId,
          userId,
          containerId,
        },
        "Error in container log stream",
      );

      const errorEvent: ContainerLogEvent = {
        type: "error",
        error: (error instanceof Error ? error.message : String(error)),
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.end();
    });

    // Clean up on client disconnect
    req.on("close", () => {
      logger.debug(
        {
          requestId,
          userId,
          containerId,
        },
        "Client disconnected from log stream",
      );

      logStream.destroy();
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        containerId,
      },
      "Failed to start container log stream",
    );

    // If headers haven't been sent yet, send error response
    if (!res.headersSent) {
      if (error instanceof Error && (error instanceof Error ? error.message : String(error)).includes("timeout")) {
        return res.status(504).json({
          error: "Gateway Timeout",
          message: "Docker API request timed out. Please try again.",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      next(error);
    } else {
      // Headers already sent, send error as SSE event
      const errorEvent: ContainerLogEvent = {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.end();
    }
  }
  }) as RequestHandler,
);

// Container action endpoint (start/stop/restart)
describe(
  "post",
  rel(ApiRoute.containers.action(":id", ":action" as ContainerAction)),
  {
    summary: "Perform a container lifecycle action",
    description: "Starts, stops, restarts, or removes a container.",
    tags: ["Containers"],
    permission: "containers:write",
    sideEffects:
      "starts/stops/restarts/removes a real Docker container; removal is destructive and irreversible",
    request: { params: ContainerActionParams },
    response: ContainerActionResponseSchema,
    errorResponses: [
      { status: 400, description: "Invalid container ID, action, or container not in a valid state" },
      { status: 404, description: "Container not found" },
      { status: 409, description: "Container already in the requested state" },
      { status: 503, description: "Docker service is not connected" },
      { status: 504, description: "Docker API request timed out" },
    ],
  },
  (async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id;
  const containerId = String(req.params.id);
  const action = req.params.action as ContainerAction;

  logger.debug(
    {
      requestId,
      userId,
      containerId,
      action,
    },
    "Container action requested",
  );

  try {
    // Validate container ID
    if (!containerId || !isValidContainerId(containerId)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid container ID format",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Validate action
    if (!["start", "stop", "restart", "remove"].includes(action)) {
      return res.status(400).json({
        error: "Bad Request",
        message: `Invalid action '${action}'. Must be 'start', 'stop', 'restart', or 'remove'`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    const dockerService = DockerService.getInstance();

    // Check Docker service connectivity
    if (!dockerService.isConnected()) {
      logger.error(
        {
          requestId,
          userId,
          containerId,
          action,
        },
        "Docker service not connected",
      );

      return res.status(503).json({
        error: "Service Unavailable",
        message: "Docker service is not available. Please try again later.",
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Verify container exists
    const containerInfo = await dockerService.getContainer(containerId);
    if (!containerInfo) {
      logger.warn(
        {
          requestId,
          userId,
          containerId,
          action,
        },
        "Container not found for action",
      );

      return res.status(404).json({
        error: "Not Found",
        message: `Container with ID '${containerId}' not found`,
        timestamp: new Date().toISOString(),
        requestId,
      });
    }

    // Get Docker instance
    const docker = await dockerService.getDockerInstance();
    const container = docker.getContainer(containerId);

    // Perform the action
    logger.info(
      {
        requestId,
        userId,
        containerId,
        containerName: containerInfo.name,
        action,
        currentStatus: containerInfo.status,
      },
      `Performing container ${action}`,
    );

    switch (action) {
      case "start":
        await container.start();
        break;
      case "stop":
        await container.stop({ t: 10 }); // 10-second grace period
        break;
      case "restart":
        await container.restart({ t: 10 }); // 10-second grace period
        break;
      case "remove":
        // Remove container (force: true to remove even if stopped)
        await container.remove({ force: false, v: false });
        break;
    }

    // Flush cache to get updated container status
    dockerService.flushCache();

    // Get updated container info (skip for remove since container no longer exists)
    const updatedContainer = action === "remove" ? null : await dockerService.getContainer(containerId);

    logger.info(
      {
        requestId,
        userId,
        containerId,
        containerName: containerInfo.name,
        action,
        newStatus: updatedContainer?.status,
      },
      `Container ${action} completed successfully`,
    );

    // Emit granular socket events for immediate UI updates
    if (action === "remove") {
      emitToChannel(Channel.CONTAINERS, ServerEvent.CONTAINER_REMOVED, {
        id: containerId,
        name: containerInfo.name,
      });
    } else if (updatedContainer) {
      emitToChannel(Channel.CONTAINERS, ServerEvent.CONTAINER_STATUS, {
        id: containerId,
        name: containerInfo.name,
        status: updatedContainer.status,
      });
    }

    const response: ContainerActionResponse = {
      success: true,
      message: `Container ${action} completed successfully`,
      containerId,
      action,
      status: updatedContainer?.status,
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
        containerId,
        action,
      },
      `Failed to ${action} container`,
    );

    // Handle specific Docker API errors
    if (error instanceof Error) {
      // Container already in requested state
      if ((error instanceof Error ? error.message : String(error)).includes("already")) {
        return res.status(409).json({
          error: "Conflict",
          message: (error instanceof Error ? error.message : String(error)),
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Timeout
      if ((error instanceof Error ? error.message : String(error)).includes("timeout")) {
        return res.status(504).json({
          error: "Gateway Timeout",
          message: "Docker API request timed out. Please try again.",
          timestamp: new Date().toISOString(),
          requestId,
        });
      }

      // Not running (for stop/restart)
      if ((error instanceof Error ? error.message : String(error)).includes("not running")) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Cannot ${action} container: container is not running`,
          timestamp: new Date().toISOString(),
          requestId,
        });
      }
    }

    next(error);
  }
  }) as RequestHandler,
);

export default router;
