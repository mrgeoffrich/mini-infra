import express, { Request, Response, NextFunction } from "express";
import DockerService from "../services/docker";
import { VolumeInspectorService, VolumeFileContentService } from "../services/volume";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import {
  DockerNetworkListResponse,
  DockerNetworkApiResponse,
  DockerNetworkDeleteResponse,
  DockerVolumeListResponse,
  DockerVolumeApiResponse,
  DockerVolumeDeleteResponse,
  VolumeInspectionResponse,
  VolumeInspectionStartResponse,
  FetchFileContentsRequest,
  FetchFileContentsResponse,
  VolumeFileContentResponse,
} from "@mini-infra/types";

const logger = appLogger();
const router = express.Router();

/**
 * GET /api/docker/networks
 * List all Docker networks
 */
router.get(
  "/networks",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      const networks = await dockerService.listNetworks();

      const response: DockerNetworkListResponse = {
        networks,
        totalCount: networks.length,
        lastUpdated: new Date().toISOString(),
      };

      const apiResponse: DockerNetworkApiResponse = {
        success: true,
        data: response,
      };

      res.json(apiResponse);
    } catch (error) {
      logger.error({ error }, "Failed to list Docker networks");
      next(error);
    }
  }
);

/**
 * DELETE /api/docker/networks/:id
 * Remove a Docker network by ID
 * Only removes networks that have no containers attached
 */
router.delete(
  "/networks/:id",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: "Network ID is required",
        });
      }

      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      await dockerService.removeNetwork(id);

      const response: DockerNetworkDeleteResponse = {
        success: true,
        message: "Network removed successfully",
        networkId: id,
      };

      res.json(response);
    } catch (error: any) {
      if (error.message?.includes("Cannot remove network")) {
        logger.warn({ error, networkId: req.params.id }, "Cannot remove network");
        return res.status(400).json({
          success: false,
          message: error.message,
          networkId: req.params.id,
        });
      }

      logger.error({ error, networkId: req.params.id }, "Failed to remove Docker network");
      next(error);
    }
  }
);

/**
 * GET /api/docker/volumes
 * List all Docker volumes
 */
router.get(
  "/volumes",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      const volumes = await dockerService.listVolumes();

      const response: DockerVolumeListResponse = {
        volumes,
        totalCount: volumes.length,
        lastUpdated: new Date().toISOString(),
      };

      const apiResponse: DockerVolumeApiResponse = {
        success: true,
        data: response,
      };

      res.json(apiResponse);
    } catch (error) {
      logger.error({ error }, "Failed to list Docker volumes");
      next(error);
    }
  }
);

/**
 * DELETE /api/docker/volumes/:name
 * Remove a Docker volume by name
 * Only removes volumes that are not in use by any containers
 */
router.delete(
  "/volumes/:name",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Volume name is required",
        });
      }

      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      await dockerService.removeVolume(name);

      const response: DockerVolumeDeleteResponse = {
        success: true,
        message: "Volume removed successfully",
        volumeName: name,
      };

      res.json(response);
    } catch (error: any) {
      if (error.message?.includes("Cannot remove volume")) {
        logger.warn({ error, volumeName: req.params.name }, "Cannot remove volume");
        return res.status(400).json({
          success: false,
          message: error.message,
          volumeName: req.params.name,
        });
      }

      logger.error({ error, volumeName: req.params.name }, "Failed to remove Docker volume");
      next(error);
    }
  }
);

/**
 * POST /api/docker/volumes/:name/inspect
 * Start inspection of a Docker volume
 * Creates an Alpine container that mounts the volume and scans all files
 */
router.post(
  "/volumes/:name/inspect",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Volume name is required",
        });
      }

      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      // Verify volume exists
      const volumes = await dockerService.listVolumes();
      const volumeExists = volumes.some((v) => v.name === name);

      if (!volumeExists) {
        return res.status(404).json({
          success: false,
          message: `Volume '${name}' not found`,
        });
      }

      // Initialize and start inspection
      const inspectorService = new VolumeInspectorService();
      await inspectorService.initialize();
      await inspectorService.startInspection(name);

      const response: VolumeInspectionStartResponse = {
        success: true,
        data: {
          volumeName: name,
          status: "running",
          message: "Volume inspection started",
        },
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error, volumeName: req.params.name },
        "Failed to start volume inspection",
      );
      next(error);
    }
  }
);

/**
 * GET /api/docker/volumes/:name/inspect
 * Get inspection status and results for a Docker volume
 */
router.get(
  "/volumes/:name/inspect",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Volume name is required",
        });
      }

      const inspectorService = new VolumeInspectorService();
      await inspectorService.initialize();
      const inspection = await inspectorService.getInspection(name);

      if (!inspection) {
        return res.status(404).json({
          success: false,
          message: `No inspection found for volume '${name}'`,
        });
      }

      // Convert inspection data to API response format
      const response: VolumeInspectionResponse = {
        success: true,
        data: {
          id: inspection.id,
          volumeName: inspection.volumeName,
          status: inspection.status,
          inspectedAt: inspection.inspectedAt.toISOString(),
          completedAt: inspection.completedAt?.toISOString() || null,
          durationMs: inspection.durationMs,
          fileCount: inspection.fileCount,
          totalSize: inspection.totalSize ? Number(inspection.totalSize) : null,
          files: inspection.files,
          stdout: inspection.stdout,
          stderr: inspection.stderr,
          errorMessage: inspection.errorMessage,
          createdAt: inspection.createdAt.toISOString(),
          updatedAt: inspection.updatedAt.toISOString(),
        },
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error, volumeName: req.params.name },
        "Failed to get volume inspection",
      );
      next(error);
    }
  }
);

/**
 * POST /api/docker/volumes/:name/files/fetch
 * Fetch contents of multiple files from a Docker volume
 * Batch operation that reads multiple files in a single container execution
 */
router.post(
  "/volumes/:name/files/fetch",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;
      const { filePaths } = req.body as FetchFileContentsRequest;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Volume name is required",
        });
      }

      if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
        return res.status(400).json({
          success: false,
          message: "filePaths array is required and must not be empty",
        });
      }

      const dockerService = DockerService.getInstance();

      if (!dockerService.isConnected()) {
        logger.warn("Docker service not connected");
        return res.status(503).json({
          success: false,
          message: "Docker service not connected",
        });
      }

      // Verify volume exists
      const volumes = await dockerService.listVolumes();
      const volumeExists = volumes.some((v) => v.name === name);

      if (!volumeExists) {
        return res.status(404).json({
          success: false,
          message: `Volume '${name}' not found`,
        });
      }

      // Initialize and fetch file contents
      const fileContentService = new VolumeFileContentService();
      await fileContentService.initialize();
      const result = await fileContentService.fetchFileContents(name, filePaths);

      const response: FetchFileContentsResponse = {
        success: true,
        data: {
          fetched: result.fetched,
          skipped: result.skipped,
          errors: result.errors,
        },
        message: `Fetched ${result.fetched} file(s), skipped ${result.skipped}`,
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error, volumeName: req.params.name },
        "Failed to fetch file contents",
      );
      next(error);
    }
  }
);

/**
 * GET /api/docker/volumes/:name/files
 * Get a single file's content from a Docker volume
 * Query parameter: path (URL-encoded file path)
 */
router.get(
  "/volumes/:name/files",
  requireSessionOrApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name } = req.params;
      const { path } = req.query;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Volume name is required",
        });
      }

      if (!path || typeof path !== "string") {
        return res.status(400).json({
          success: false,
          message: "path query parameter is required",
        });
      }

      const fileContentService = new VolumeFileContentService();
      await fileContentService.initialize();
      const fileContent = await fileContentService.getFileContent(name, path);

      if (!fileContent) {
        return res.status(404).json({
          success: false,
          message: `File content not found for '${path}' in volume '${name}'`,
        });
      }

      const response: VolumeFileContentResponse = {
        success: true,
        data: fileContent,
      };

      res.json(response);
    } catch (error: any) {
      logger.error(
        { error, volumeName: req.params.name, filePath: req.query.path },
        "Failed to get file content",
      );
      next(error);
    }
  }
);

export default router;
