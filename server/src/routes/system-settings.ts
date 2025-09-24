import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
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

interface TestDockerRegistryRequest extends Request {
  body: {
    type: "backup" | "restore";
    image: string;
    registryUsername?: string;
    registryPassword?: string;
  };
}

interface TestDockerRegistryResponse {
  success: boolean;
  message: string;
  details: {
    image: string;
    authenticated: boolean;
    pullTimeMs?: number;
    errorCode?: string;
  };
}

/**
 * @swagger
 * /api/settings/system/test-docker-registry:
 *   post:
 *     summary: Test Docker registry connection
 *     description: Test connectivity and authentication to a Docker registry by attempting to pull a specified image
 *     tags:
 *       - Settings
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - image
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [backup, restore]
 *                 description: The type of operation this registry will be used for
 *                 example: "backup"
 *               image:
 *                 type: string
 *                 minLength: 1
 *                 description: Docker image to test with (used for pull testing)
 *                 example: "postgres:15-alpine"
 *               registryUsername:
 *                 type: string
 *                 description: Registry username for authentication (optional)
 *                 example: "myregistry_user"
 *               registryPassword:
 *                 type: string
 *                 format: password
 *                 description: Registry password for authentication (optional)
 *                 example: "secure_password_123"
 *           examples:
 *             publicRegistry:
 *               summary: Test public registry (no auth)
 *               value:
 *                 type: "backup"
 *                 image: "postgres:15-alpine"
 *             privateRegistry:
 *               summary: Test private registry (with auth)
 *               value:
 *                 type: "backup"
 *                 image: "myregistry.com/postgres:15-alpine"
 *                 registryUsername: "myuser"
 *                 registryPassword: "mypassword"
 *     responses:
 *       200:
 *         description: Registry test completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Whether the registry test was successful
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Human-readable result message
 *                   example: "Docker registry test completed successfully"
 *                 details:
 *                   type: object
 *                   properties:
 *                     image:
 *                       type: string
 *                       description: The image that was tested
 *                       example: "postgres:15-alpine"
 *                     authenticated:
 *                       type: boolean
 *                       description: Whether authentication was used
 *                       example: false
 *                     pullTimeMs:
 *                       type: number
 *                       description: Time taken to pull the image in milliseconds
 *                       example: 2350
 *                     errorCode:
 *                       type: string
 *                       description: Error code if the test failed
 *                       example: null
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Invalid request data"
 *                 details:
 *                   type: object
 *                   properties:
 *                     image:
 *                       type: string
 *                       example: ""
 *                     authenticated:
 *                       type: boolean
 *                       example: false
 *                     errorCode:
 *                       type: string
 *                       example: "VALIDATION_ERROR"
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "User not authenticated"
 *                 details:
 *                   type: object
 *                   properties:
 *                     image:
 *                       type: string
 *                       example: "unknown"
 *                     authenticated:
 *                       type: boolean
 *                       example: false
 *                     pullTimeMs:
 *                       type: number
 *                       example: 0
 *       500:
 *         description: Registry test failed or internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Docker registry test failed"
 *                 details:
 *                   type: object
 *                   properties:
 *                     image:
 *                       type: string
 *                       example: "postgres:15-alpine"
 *                     authenticated:
 *                       type: boolean
 *                       example: false
 *                     errorCode:
 *                       type: string
 *                       example: "DOCKER_PULL_FAILED"
 *
 * POST /api/settings/system/test-docker-registry - Test Docker registry connection
 */
router.post("/test-docker-registry", requireSessionOrApiKey, (async (
  req: TestDockerRegistryRequest,
  res: Response<TestDockerRegistryResponse>,
  next: NextFunction,
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
