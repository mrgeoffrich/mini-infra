import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import { githubAppService } from "../services/github-app";

const router = express.Router();

/**
 * GET /api/github-app/packages - List container packages
 */
router.get("/packages", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App packages list requested",
  );

  try {
    const packages = await githubAppService.listPackages();

    logger.debug(
      {
        requestId,
        userId,
        packageCount: packages.length,
      },
      "GitHub App packages retrieved successfully",
    );

    res.json({
      success: true,
      data: packages,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to list GitHub App packages",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/github-app/packages/:packageName/versions - List package versions
 */
router.get("/packages/:packageName/versions", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";
  const packageName = String(req.params.packageName);

  logger.debug(
    {
      requestId,
      userId,
      packageName,
    },
    "GitHub App package versions requested",
  );

  try {
    const versions = await githubAppService.listPackageVersions(packageName);

    logger.debug(
      {
        requestId,
        userId,
        packageName,
        versionCount: versions.length,
      },
      "GitHub App package versions retrieved successfully",
    );

    res.json({
      success: true,
      data: versions,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        packageName,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to list GitHub App package versions",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/github-app/repos - List repositories
 */
router.get("/repos", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "GitHub App repositories list requested",
  );

  try {
    const repositories = await githubAppService.listRepositories();

    logger.debug(
      {
        requestId,
        userId,
        repositoryCount: repositories.length,
      },
      "GitHub App repositories retrieved successfully",
    );

    res.json({
      success: true,
      data: repositories,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to list GitHub App repositories",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/github-app/repos/:owner/:repo/actions/runs - List action runs
 */
router.get("/repos/:owner/:repo/actions/runs", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";
  const owner = String(req.params.owner); const repo = String(req.params.repo);

  logger.debug(
    {
      requestId,
      userId,
      owner,
      repo,
    },
    "GitHub App action runs requested",
  );

  try {
    const runs = await githubAppService.listActionRuns(owner, repo);

    logger.debug(
      {
        requestId,
        userId,
        owner,
        repo,
        runCount: runs.length,
      },
      "GitHub App action runs retrieved successfully",
    );

    res.json({
      success: true,
      data: runs,
    });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        owner,
        repo,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to list GitHub App action runs",
    );

    next(error);
  }
}) as RequestHandler);

export default router;
