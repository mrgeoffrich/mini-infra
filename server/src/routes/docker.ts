import express, { Request, Response, NextFunction } from "express";
import DockerService from "../services/docker";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey } from "../middleware/auth";
import {
  DockerNetworkListResponse,
  DockerNetworkApiResponse,
  DockerNetworkDeleteResponse,
  DockerVolumeListResponse,
  DockerVolumeApiResponse,
  DockerVolumeDeleteResponse,
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

export default router;
