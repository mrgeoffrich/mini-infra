import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import DockerService from "../services/docker";
import { VolumeInspectorService, VolumeFileContentService } from "../services/volume";
import { getLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import { DockerNetworkListResponse, DockerNetworkApiResponse, DockerNetworkDeleteResponse, NetworkAttachmentResponse, DockerVolumeListResponse, DockerVolumeApiResponse, DockerVolumeDeleteResponse, VolumeInspectionResponse, VolumeInspectionStartResponse, FetchFileContentsRequest, FetchFileContentsResponse, VolumeFileContentResponse, DockerNetworkGcResponse, NetworkMembershipBackfillResponse, NetworkReconcileResponse, NetworkConvergeResponse, SetNetworkEnforceMembershipsResponse, ManagedNetworkListResponse, Permission, ErrorCode } from "@mini-infra/types";
import prisma from "../lib/prisma";
import { DockerExecutorService } from "../services/docker-executor";
import { createNetworkManager, runNetworkGc, backfillNetworkMemberships, reconcileStack, reconcileEnvironment, reconcileAll, convergeStack, convergeEnvironment, convergeAll, listManagedNetworks } from "../services/networks";
import { requireDockerConnected } from "../middleware/require-docker-connected";
import { NotFoundError, ValidationError } from "../lib/errors";

const logger = getLogger("docker", "docker");
const router = express.Router();

const networkGcRequestSchema = z.object({
  dryRun: z.boolean().optional(),
});

const networkReconcileQuerySchema = z.object({
  scope: z.enum(["stack", "environment", "all"]).default("all"),
  stackId: z.string().optional(),
  environmentId: z.string().optional(),
}).refine((v) => v.scope !== "stack" || Boolean(v.stackId), {
  message: "stackId is required when scope=stack",
}).refine((v) => v.scope !== "environment" || Boolean(v.environmentId), {
  message: "environmentId is required when scope=environment",
});

const setEnforceMembershipsSchema = z.object({
  name: z.string().min(1),
  enforceMemberships: z.boolean(),
});

const managedNetworkListQuerySchema = z.object({
  scope: z.enum(["host", "environment", "stack"]).optional(),
  environmentId: z.string().optional(),
  stackId: z.string().optional(),
});

const containerNetworkMutationSchema = z.object({
  containerId: z.string().min(1),
  force: z.boolean().optional(),
});

/**
 * GET /api/docker/info
 * Returns Docker daemon information (version, OS, container counts, etc.)
 */
router.get(
  "/info",
  requirePermission(Permission.DockerRead),
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

      const docker = await dockerService.getDockerInstance();
      const info = await docker.info();

      res.json({
        success: true,
        data: {
          serverVersion: info.ServerVersion,
          os: info.OperatingSystem,
          architecture: info.Architecture,
          kernelVersion: info.KernelVersion,
          totalMemory: info.MemTotal,
          cpus: info.NCPU,
          containers: info.Containers,
          containersRunning: info.ContainersRunning,
          containersPaused: info.ContainersPaused,
          containersStopped: info.ContainersStopped,
          images: info.Images,
          storageDriver: info.Driver,
          dockerRootDir: info.DockerRootDir,
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to get Docker info");
      next(error);
    }
  }
);

/**
 * GET /api/docker/networks
 * List all Docker networks
 */
router.get(
  "/networks",
  requirePermission(Permission.DockerRead),
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
 * GET /api/docker/networks/managed
 * Network overhaul Phase 9 — every `ManagedNetwork` row (optionally
 * filtered by `scope`/`environmentId`/`stackId`) with its resolved owner,
 * live Docker existence/subnet, drift status (reused from the Phase 7
 * reconciler), and a full desired-vs-actual membership table — each
 * membership's `source`/`createdBy` and whether it's actually attached
 * right now. This is the read side of the networks tab's managed-network
 * view, the environment detail networks panel, and the application detail
 * connected-networks list. Admin-gated like the rest of this subsystem's
 * diagnostic/admin surface (GC/backfill/reconcile above), even though it's
 * read-only, for consistency.
 */
router.get(
  "/networks/managed",
  requirePermission(Permission.DockerAdmin),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = managedNetworkListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid query parameters",
          details: parsed.error.issues,
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

      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);
      const deps = { prisma, networkManager, dockerExecutor: executor, log: logger };

      const data = await listManagedNetworks(deps, parsed.data);

      const response: ManagedNetworkListResponse = { success: true, data };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Failed to list managed networks");
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
  requirePermission(Permission.DockerWrite),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);

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
    } catch (error) {
      // Taxonomy errors thrown by DockerService.removeNetwork() (has-containers
      // -> 409 DOCKER_NETWORK_IN_USE, not-found -> 404 DOCKER_NETWORK_NOT_FOUND)
      // carry their own status/code and reach the central middleware via
      // next(error) below — no more message-substring status mapping here.
      logger.error({ error, networkId: req.params.id }, "Failed to remove Docker network");
      next(error);
    }
  }
);

/**
 * POST /api/docker/networks/:id/connect
 * Attach a container to a Docker network — the imperative equivalent of
 * `docker network connect <network> <container>`. Idempotent: re-attaching an
 * already-attached container succeeds as a no-op (`alreadyConnected: true`).
 *
 * Gated by `docker:write` (an ordinary network mutation, mirroring the
 * single-network DELETE above) rather than the `docker:admin` the declarative
 * managed-network endpoints use — this is a direct, user-driven attach, not
 * managed-network administration.
 */
router.post(
  "/networks/:id/connect",
  requirePermission(Permission.DockerWrite),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const networkId = String(req.params.id);
      const parsed = containerNetworkMutationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
          details: parsed.error.issues,
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

      const { containerId } = parsed.data;
      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);
      const result = await networkManager.connect(containerId, networkId);

      const response: NetworkAttachmentResponse = {
        success: true,
        message: result.alreadyConnected
          ? "Container is already connected to this network"
          : "Container connected to network successfully",
        networkId,
        containerId,
        alreadyConnected: result.alreadyConnected,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error, networkId: req.params.id },
        "Failed to connect container to network",
      );
      next(error);
    }
  }
);

/**
 * POST /api/docker/networks/:id/disconnect
 * Detach a container from a Docker network — the imperative equivalent of
 * `docker network disconnect <network> <container>`. Idempotent: disconnecting
 * an already-detached container (or a network that's already gone) is a no-op
 * success. Pass `{ force: true }` to force-disconnect. `docker:write`, like
 * connect above.
 */
router.post(
  "/networks/:id/disconnect",
  requirePermission(Permission.DockerWrite),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const networkId = String(req.params.id);
      const parsed = containerNetworkMutationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
          details: parsed.error.issues,
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

      const { containerId, force } = parsed.data;
      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);
      await networkManager.disconnect(containerId, networkId, { force });

      const response: NetworkAttachmentResponse = {
        success: true,
        message: "Container disconnected from network successfully",
        networkId,
        containerId,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error, networkId: req.params.id },
        "Failed to disconnect container from network",
      );
      next(error);
    }
  }
);

/**
 * POST /api/docker/networks/gc
 * Network overhaul Phase 4 — label-driven GC sweep. Dry-run by default;
 * pass `{ dryRun: false }` to actually remove orphaned managed networks.
 * Admin-only: this can delete Docker resources outside the usual
 * stack/environment lifecycle, so it requires `docker:admin` (a step above
 * the `docker:write` that gates the single-network DELETE above), mirroring
 * the `vault:admin`/`nats:admin` precedent for "administration" actions
 * distinct from ordinary reads/writes.
 */
router.post(
  "/networks/gc",
  requirePermission(Permission.DockerAdmin),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = networkGcRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
          details: parsed.error.issues,
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

      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);

      const dryRun = parsed.data.dryRun ?? true;
      const report = await runNetworkGc(networkManager, prisma, { dryRun });

      logger.info(
        {
          dryRun,
          scannedCount: report.scannedCount,
          orphanCount: report.orphans.length,
          removedCount: report.removedCount,
        },
        "Network GC run via admin endpoint",
      );

      const response: DockerNetworkGcResponse = { success: true, data: report };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Network GC run failed");
      next(error);
    }
  }
);

/**
 * POST /api/docker/networks/backfill-memberships
 * Network overhaul Phase 6 — on-demand re-run of the ManagedNetwork/
 * NetworkMembership backfill (also runs once at boot; see server.ts). Purely
 * additive (find-or-create throughout) — safe to call repeatedly, and never
 * removes or mutates existing rows. Admin-only, mirroring the GC endpoint's
 * `docker:admin` gate above.
 */
router.post(
  "/networks/backfill-memberships",
  requirePermission(Permission.DockerAdmin),
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

      const executor = new DockerExecutorService();
      await executor.initialize();

      const summary = await backfillNetworkMemberships(executor, prisma, logger);

      logger.info({ ...summary }, "Network membership backfill run via admin endpoint");

      const response: NetworkMembershipBackfillResponse = { success: true, data: summary };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Network membership backfill run failed");
      next(error);
    }
  }
);

/**
 * GET /api/docker/networks/reconcile
 * Network overhaul Phase 7 — dry-run diff between desired-state
 * `ManagedNetwork`/`NetworkMembership` rows and live Docker state. Report-only:
 * never connects/disconnects/creates/removes anything (that's Phase 8). This
 * is the same drift computation the stack plan endpoint
 * (`GET /:stackId/plan`) folds into `StackPlan.networkActions` for a single
 * stack — exposed here standalone so an operator (or the Phase 9 UI) can
 * check environment/host-scoped networks too, which no stack's plan covers.
 * Admin-gated like the GC/backfill endpoints above, even though it's
 * read-only, for consistency with this subsystem's other diagnostic/admin
 * surface.
 */
router.get(
  "/networks/reconcile",
  requirePermission(Permission.DockerAdmin),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = networkReconcileQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid query parameters",
          details: parsed.error.issues,
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

      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);
      const deps = { prisma, networkManager, dockerExecutor: executor, log: logger };

      const { scope, stackId, environmentId } = parsed.data;
      const report =
        scope === "stack"
          ? await reconcileStack(stackId!, deps)
          : scope === "environment"
            ? await reconcileEnvironment(environmentId!, deps)
            : await reconcileAll(deps);

      logger.info(
        {
          scope,
          networksChecked: report.networksChecked,
          membershipsChecked: report.membershipsChecked,
          itemCount: report.items.length,
          noteCount: report.notes.length,
        },
        "Network reconcile run via admin endpoint",
      );

      const response: NetworkReconcileResponse = { success: true, data: report };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Network reconcile run failed");
      next(error);
    }
  }
);

/**
 * POST /api/docker/networks/reconcile
 * Network overhaul Phase 8 — manual convergence trigger. Sibling of the
 * Phase 7 `GET /api/docker/networks/reconcile` (report-only diff): this one
 * actually acts on the diff — `ensure()`s missing networks and `connect()`s
 * missing memberships (always), and `disconnect()`s stale endpoints ONLY on
 * networks whose `enforceMemberships` is true (default false everywhere,
 * so by default this endpoint behaves as a connect-only "re-attach
 * everything this scope declares" action). This is the operator-facing
 * escape hatch for "I know something drifted, fix it now" instead of
 * waiting for the next periodic sweep or a matching Docker event.
 * Admin-gated like the read-only GET above.
 */
router.post(
  "/networks/reconcile",
  requirePermission(Permission.DockerAdmin),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = networkReconcileQuerySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
          details: parsed.error.issues,
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

      const executor = new DockerExecutorService();
      await executor.initialize();
      const networkManager = createNetworkManager(executor);
      const deps = { prisma, networkManager, dockerExecutor: executor, log: logger };

      const { scope, stackId, environmentId } = parsed.data;
      const result =
        scope === "stack"
          ? await convergeStack(stackId!, deps)
          : scope === "environment"
            ? await convergeEnvironment(environmentId!, deps)
            : await convergeAll(deps);

      logger.info(
        {
          scope,
          networksEnsured: result.networksEnsured,
          networksCreated: result.networksCreated,
          membershipsConnected: result.membershipsConnected,
          membershipsDisconnected: result.membershipsDisconnected,
          skippedDisconnects: result.skippedDisconnects,
          skippedRecentContainers: result.skippedRecentContainers,
          errors: result.errors,
        },
        "Network convergence run via admin endpoint",
      );

      const response: NetworkConvergeResponse = { success: true, data: result };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Network convergence run failed");
      next(error);
    }
  }
);

/**
 * PATCH /api/docker/networks/managed/enforce-memberships
 * Network overhaul Phase 8 — sets the per-network `enforceMemberships` gate
 * that decides whether the reconciler's conservative `membership-stale`
 * findings are ever acted on (disconnected) for THAT network. Defaults to
 * false for every network and stays false until an operator explicitly
 * opts a specific network in here — this is that opt-in surface. Keyed by
 * Docker network `name` (already visible via `GET /api/docker/networks` /
 * `docker network ls`) rather than the internal `ManagedNetwork.id`, since
 * no "list managed networks" surface exists yet (that's the Phase 9
 * networks tab; this endpoint is the API Phase 9's toggle will call).
 * Admin-gated like the rest of this subsystem's mutating endpoints.
 */
router.patch(
  "/networks/managed/enforce-memberships",
  requirePermission(Permission.DockerAdmin),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = setEnforceMembershipsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid request body",
          details: parsed.error.issues,
        });
      }

      const { name, enforceMemberships } = parsed.data;
      const existing = await prisma.managedNetwork.findUnique({ where: { name } });
      if (!existing) {
        throw new NotFoundError(
          ErrorCode.MANAGED_NETWORK_NOT_FOUND,
          `No managed network found with name "${name}".`,
          { resource: { type: 'managedNetwork', name } },
        );
      }

      const updated = await prisma.managedNetwork.update({
        where: { name },
        data: { enforceMemberships },
        select: { id: true, name: true, scope: true, purpose: true, enforceMemberships: true },
      });

      logger.info(
        { name, enforceMemberships, managedNetworkId: updated.id },
        "Network enforceMemberships flag updated via admin endpoint",
      );

      const response: SetNetworkEnforceMembershipsResponse = { success: true, data: updated };
      res.json(response);
    } catch (error) {
      logger.error({ error }, "Failed to update network enforceMemberships flag");
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
  requirePermission(Permission.DockerRead),
  requireDockerConnected(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dockerService = DockerService.getInstance();
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
  requirePermission(Permission.DockerWrite),
  requireDockerConnected(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params.name);

      if (!name) {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "Volume name is required");
      }

      const dockerService = DockerService.getInstance();
      await dockerService.removeVolume(name);

      const response: DockerVolumeDeleteResponse = {
        success: true,
        message: "Volume removed successfully",
        volumeName: name,
      };

      res.json(response);
    } catch (error) {
      // Taxonomy errors — including the `ConflictError` `removeVolume()`
      // throws when the volume is in use — carry their own status/code and
      // are handled by the central error middleware; just forward them.
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
  requirePermission(Permission.DockerRead),
  requireDockerConnected(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params.name);

      if (!name) {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "Volume name is required");
      }

      const dockerService = DockerService.getInstance();

      // Verify volume exists
      const volumes = await dockerService.listVolumes();
      const volumeExists = volumes.some((v) => v.name === name);

      if (!volumeExists) {
        throw new NotFoundError(
          ErrorCode.VOLUME_NOT_FOUND,
          `Volume '${name}' not found`,
          {
            resource: { type: "volume", name },
            action: "Check the volume name and try again.",
          },
        );
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
    } catch (error) {
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
  requirePermission(Permission.DockerRead),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params.name);

      if (!name) {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "Volume name is required");
      }

      const inspectorService = new VolumeInspectorService();
      await inspectorService.initialize();
      const inspection = await inspectorService.getInspection(name);

      // "No inspection yet" is a valid state for any volume the user hasn't
      // explicitly inspected, so we surface it as 200 with data: null rather
      // than 404 — list views call this for every row and 4xx responses
      // create persistent console noise even when the UI handles it gracefully.
      const response: VolumeInspectionResponse = inspection
        ? {
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
          }
        : { success: true, data: null };

      res.json(response);
    } catch (error) {
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
  requirePermission(Permission.DockerRead),
  requireDockerConnected(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params.name);
      const { filePaths } = req.body as FetchFileContentsRequest;

      if (!name) {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "Volume name is required");
      }

      if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
        throw new ValidationError(
          ErrorCode.VALIDATION_FAILED,
          "filePaths array is required and must not be empty",
        );
      }

      const dockerService = DockerService.getInstance();

      // Verify volume exists
      const volumes = await dockerService.listVolumes();
      const volumeExists = volumes.some((v) => v.name === name);

      if (!volumeExists) {
        throw new NotFoundError(
          ErrorCode.VOLUME_NOT_FOUND,
          `Volume '${name}' not found`,
          {
            resource: { type: "volume", name },
            action: "Check the volume name and try again.",
          },
        );
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
    } catch (error) {
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
  requirePermission(Permission.DockerRead),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params.name);
      const { path } = req.query;

      if (!name) {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "Volume name is required");
      }

      if (!path || typeof path !== "string") {
        throw new ValidationError(ErrorCode.VALIDATION_FAILED, "path query parameter is required");
      }

      const fileContentService = new VolumeFileContentService();
      await fileContentService.initialize();
      const fileContent = await fileContentService.getFileContent(name, path);

      if (!fileContent) {
        throw new NotFoundError(
          ErrorCode.VOLUME_FILE_NOT_FOUND,
          `File content not found for '${path}' in volume '${name}'`,
          {
            resource: { type: "volumeFile", name: `${name}:${path}` },
            action: "Fetch the file contents first, then try again.",
          },
        );
      }

      const response: VolumeFileContentResponse = {
        success: true,
        data: fileContent,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error, volumeName: req.params.name, filePath: req.query.path },
        "Failed to get file content",
      );
      next(error);
    }
  }
);

export default router;
