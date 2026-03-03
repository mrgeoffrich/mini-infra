import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = express.Router();

/**
 * GET /api/settings/docker-host - Get Docker host IP for connections
 */
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
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
    "Docker host IP requested",
  );

  try {
    // Get the docker host setting from the database
    const dockerHostSetting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: "docker",
          key: "host",
        },
      },
    });

    let host = "localhost"; // Default fallback

    if (dockerHostSetting?.value) {
      const hostValue = dockerHostSetting.value;

      // Parse different Docker host formats
      // Examples: "tcp://192.168.1.100:2375", "http://192.168.1.100:2375", "unix:///var/run/docker.sock"

      if (hostValue.startsWith("tcp://") || hostValue.startsWith("http://") || hostValue.startsWith("https://")) {
        // Extract host from URL
        try {
          const url = new URL(hostValue.replace("tcp://", "http://"));
          host = url.hostname;
        } catch (error) {
          // If URL parsing fails, try to extract manually
          const match = hostValue.match(/^(?:tcp|https?):\/\/([^:\/]+)/);
          if (match && match[1]) {
            host = match[1];
          }
        }
      } else if (hostValue.includes(":") && !hostValue.includes("/")) {
        // Format: "host:port"
        const parts = hostValue.split(":");
        host = parts[0];
      } else if (!hostValue.startsWith("unix://") && !hostValue.startsWith("/") && !hostValue.startsWith("npipe://") && !hostValue.includes("pipe")) {
        // If it's not a socket/pipe path, use it as-is
        host = hostValue;
      }
      // For Unix sockets, Windows pipes, etc., we keep the default "localhost"
    }

    logger.debug(
      {
        requestId,
        userId,
        host,
        originalValue: dockerHostSetting?.value,
      },
      "Docker host IP returned successfully",
    );

    res.json({
      success: true,
      data: {
        host,
        source: dockerHostSetting ? "settings" : "default",
      },
    });
  } catch (error) {
    logger.error(
      {
        error,
        requestId,
        userId,
      },
      "Failed to fetch Docker host IP",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
