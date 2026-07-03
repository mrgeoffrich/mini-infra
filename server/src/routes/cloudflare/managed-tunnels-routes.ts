import express, { Request, RequestHandler } from "express";
import { z } from "zod";
import { getLogger } from "../../lib/logger-factory";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import prisma from "../../lib/prisma";
import { CloudflareService } from "../../services/cloudflare";
import { StackTemplateService } from "../../services/stacks/stack-template-service";
import { tunnelCache } from "../../services/cloudflare/tunnel-cache";
import { ManagedTunnelListResponse, ManagedTunnelResponse, ManagedTunnelWithStack, Permission } from "@mini-infra/types";

const logger = getLogger("integrations", "managed-tunnels-routes");

const createManagedTunnelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Tunnel name can only contain letters, numbers, hyphens, and underscores",
    ),
});

function getUserId(req: Request): string {
  return getAuthenticatedUser(req)?.id || "system";
}

export function createManagedTunnelsRouter(
  cloudflareConfigService: CloudflareService,
): express.Router {
  const router = express.Router();

  router.get(
    "/",
    requirePermission(Permission.SettingsRead) as RequestHandler,
    asyncHandler(async (_req, res) => {
      const tunnelsMap = await cloudflareConfigService.getAllManagedTunnels();

      const stacks = await prisma.stack.findMany({
        where: { name: "cloudflare-tunnel", status: { not: "removed" } },
        select: { id: true, environmentId: true, status: true },
      });
      const stackByEnv = new Map(stacks.map((s) => [s.environmentId, s]));

      const data: ManagedTunnelWithStack[] = [];
      for (const [environmentId, info] of tunnelsMap) {
        const stack = stackByEnv.get(environmentId);
        data.push({
          tunnelId: info.tunnelId,
          tunnelName: info.tunnelName,
          environmentId,
          hasToken: info.hasToken,
          createdAt: info.createdAt,
          stackId: stack?.id,
          stackStatus: stack?.status,
        });
      }

      const response: ManagedTunnelListResponse = { success: true, data };
      res.json(response);
    }),
  );

  router.get(
    "/:environmentId",
    requirePermission(Permission.SettingsRead) as RequestHandler,
    asyncHandler(async (req, res) => {
      const environmentId = String(req.params.environmentId);
      const info =
        await cloudflareConfigService.getManagedTunnelInfo(environmentId);

      const stack = await prisma.stack.findFirst({
        where: {
          name: "cloudflare-tunnel",
          environmentId,
          status: { not: "removed" },
        },
        select: { id: true, status: true },
      });

      const data: ManagedTunnelWithStack | null = info
        ? {
            ...info,
            environmentId,
            stackId: stack?.id,
            stackStatus: stack?.status,
          }
        : null;

      const response: ManagedTunnelResponse = { success: true, data };
      res.json(response);
    }),
  );

  router.post(
    "/:environmentId",
    requirePermission(Permission.SettingsWrite) as RequestHandler,
    asyncHandler(async (req, res) => {
      const environmentId = String(req.params.environmentId);
      const userId = getUserId(req);

      const parsed = createManagedTunnelSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Invalid request",
          details: parsed.error.issues,
        });
      }

      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
      });
      if (!environment) {
        return res.status(404).json({
          success: false,
          error: "Environment not found",
        });
      }
      if (environment.networkType !== "internet") {
        return res.status(400).json({
          success: false,
          error:
            "Managed tunnels can only be created for internet-facing environments",
        });
      }

      const existing =
        await cloudflareConfigService.getManagedTunnelInfo(environmentId);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "A managed tunnel already exists for this environment",
          data: existing,
        });
      }

      // Ensure the cloudflare-tunnel connector stack exists for this
      // environment. It is never auto-provisioned on environment creation
      // (stack creation is user-initiated via template instantiation), so
      // without this the Tunnels page would strand the user at "Not Deployed"
      // with no stack for the Deploy button to act on. Idempotent — reuses an
      // already-instantiated stack. The connector reads its token dynamically
      // at apply time (dynamicEnv: cloudflare-tunnel-token), so there is no
      // stack parameter to wire and creation order no longer matters.
      let stack = await prisma.stack.findFirst({
        where: {
          name: "cloudflare-tunnel",
          environmentId,
          status: { not: "removed" },
        },
        select: { id: true, status: true },
      });

      if (!stack) {
        const template = await prisma.stackTemplate.findUnique({
          where: {
            name_source: { name: "cloudflare-tunnel", source: "system" },
          },
          select: { id: true },
        });
        if (!template) {
          return res.status(500).json({
            success: false,
            error:
              "The cloudflare-tunnel system template is missing — cannot provision the connector stack",
          });
        }
        const created = await new StackTemplateService(
          prisma,
        ).createStackFromTemplate({ templateId: template.id, environmentId }, userId);
        stack = { id: created.id, status: created.status };
        logger.info(
          { environmentId, stackId: created.id },
          "Auto-provisioned cloudflare-tunnel connector stack for managed tunnel",
        );
      }

      const result = await cloudflareConfigService.createManagedTunnel(
        environmentId,
        parsed.data.name,
        userId,
      );

      const token =
        await cloudflareConfigService.getManagedTunnelToken(environmentId);

      tunnelCache.clear();

      const response: ManagedTunnelResponse = {
        success: true,
        data: {
          tunnelId: result.tunnelId,
          tunnelName: result.tunnelName,
          environmentId,
          hasToken: !!token,
          stackId: stack.id,
          stackStatus: stack.status,
        },
        message: "Managed tunnel created successfully",
      };
      res.status(201).json(response);
    }),
  );

  router.delete(
    "/:environmentId",
    requirePermission(Permission.SettingsWrite) as RequestHandler,
    asyncHandler(async (req, res) => {
      const environmentId = String(req.params.environmentId);
      const userId = getUserId(req);

      // The tunnel stack must be stopped first; otherwise deleting the
      // tunnel leaves a running container pointed at a dead endpoint.
      const stack = await prisma.stack.findFirst({
        where: {
          name: "cloudflare-tunnel",
          environmentId,
          status: { not: "removed" },
        },
        select: { id: true, status: true },
      });

      if (stack && stack.status === "synced") {
        return res.status(409).json({
          success: false,
          error:
            "The cloudflare-tunnel stack is still running. Stop it before deleting the tunnel.",
        });
      }

      await cloudflareConfigService.deleteManagedTunnel(environmentId, userId);

      if (stack) {
        const fullStack = await prisma.stack.findUnique({
          where: { id: stack.id },
          select: { parameterValues: true },
        });
        const existingParams =
          (fullStack?.parameterValues as Record<string, string>) ?? {};
        await prisma.stack.update({
          where: { id: stack.id },
          data: {
            parameterValues: {
              ...existingParams,
              "tunnel-token": "",
            },
            status: "undeployed",
          },
        });
      }

      tunnelCache.clear();

      res.json({
        success: true,
        message: "Managed tunnel deleted successfully",
      });
    }),
  );

  return router;
}
