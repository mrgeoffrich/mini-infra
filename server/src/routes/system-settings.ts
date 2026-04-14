import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import type {
  TestDockerRegistryRequest,
  TestDockerRegistryResponse,
} from "@mini-infra/types";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import { DockerExecutorService } from "../services/docker-executor";
import type {
  DockerRegistryTestOptions,
  DockerRegistryTestResult,
} from "../services/docker-executor";

const router = express.Router();

// Request validation schema for Docker registry test
const testDockerRegistrySchema = z.object({
  type: z.enum(["backup", "restore"]),
  image: z.string().min(1, "Docker image is required"),
  registryUsername: z.string().optional(),
  registryPassword: z.string().optional(),
});

router.post("/test-docker-registry", requirePermission('settings:write') as RequestHandler, (async (
  req: Request<Record<string, string>, TestDockerRegistryResponse, TestDockerRegistryRequest>,
  res: Response<TestDockerRegistryResponse>,
  _next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User not authenticated",
      details: {
        image: "unknown",
        authenticated: false,
        pullTimeMs: 0,
      },
    });
  }

  logger.debug(
    {
      requestId,
      userId: user.id,
      userEmail: user.email,
    },
    "Docker registry test request received",
  );

  try {
    // Validate request body
    const bodyValidation = testDockerRegistrySchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn(
        {
          requestId,
          userId: user.id,
          errors: bodyValidation.error.issues,
        },
        "Invalid request body for Docker registry test",
      );

      return res.status(400).json({
        success: false,
        message: "Invalid request data",
        details: {
          image: req.body.image || "",
          authenticated: false,
          errorCode: "VALIDATION_ERROR",
        },
      });
    }

    const { type, image, registryUsername, registryPassword } =
      bodyValidation.data;

    logger.debug(
      {
        requestId,
        userId: user.id,
        type,
        image,
        hasAuth: !!(registryUsername && registryPassword),
      },
      "Testing Docker registry connection",
    );

    // Create Docker executor service and initialize
    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();

    // Test registry connection
    const testOptions: DockerRegistryTestOptions = {
      image,
      registryUsername,
      registryPassword,
    };

    const result: DockerRegistryTestResult =
      await dockerExecutor.testDockerRegistryConnection(testOptions);

    if (result.success) {
      logger.debug(
        {
          requestId,
          userId: user.id,
          type,
          image,
          pullTimeMs: result.details.pullTimeMs,
          authenticated: result.details.authenticated,
        },
        "Docker registry test successful",
      );
    } else {
      logger.warn(
        {
          requestId,
          userId: user.id,
          type,
          image,
          errorCode: result.details.errorCode,
          pullTimeMs: result.details.pullTimeMs,
        },
        "Docker registry test failed",
      );
    }

    // Return the result
    res.status(result.success ? 200 : 400).json({
      success: result.success,
      message: result.message,
      details: result.details,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      {
        requestId,
        userId: user.id,
        error: errorMessage,
        type: req.body.type,
        image: req.body.image,
      },
      "Unexpected error during Docker registry test",
    );

    return res.status(500).json({
      success: false,
      message:
        "An unexpected error occurred while testing Docker registry connection",
      details: {
        image: req.body.image || "",
        authenticated: false,
        errorCode: "INTERNAL_ERROR",
      },
    });
  }
}) as RequestHandler);

export default router;
