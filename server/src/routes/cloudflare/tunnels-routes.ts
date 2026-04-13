import express, { Request, RequestHandler } from "express";
import { z } from "zod";
import type { TunnelListResponse } from "cloudflare/resources/zero-trust/tunnels/tunnels.js";
import { appLogger } from "../../lib/logger-factory";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission, getAuthenticatedUser } from "../../middleware/auth";
import {
  CloudflareService,
  cloudflareDNSService,
} from "../../services/cloudflare";
import { tunnelCache } from "../../services/cloudflare/tunnel-cache";
import { requireCloudflareCredentials } from "./require-credentials";
import {
  CloudflareTunnelListResponse,
  CloudflareTunnelDetailsResponse,
  CloudflareTunnelConfigResponse,
  CloudflareTunnelInfo,
} from "@mini-infra/types";

const logger = appLogger();

function getUserId(req: Request): string {
  return getAuthenticatedUser(req)?.id || "system";
}

/**
 * Cloudflare's SDK typings omit fields its REST API returns at runtime
 * (connector_id, config_src, remote_config) — widen the type so we can
 * surface them to the frontend without `any`.
 */
type TunnelListResponseExtended = TunnelListResponse & {
  connector_id?: string;
  config_src?: string;
  remote_config?: boolean;
};

function toTunnelInfo(
  tunnel: TunnelListResponse,
  includeDetails = false,
): CloudflareTunnelInfo {
  const extended = tunnel as TunnelListResponseExtended;
  const base: CloudflareTunnelInfo = {
    id: tunnel.id ?? "",
    name: tunnel.name ?? "",
    status: (tunnel.status ?? "inactive") as CloudflareTunnelInfo["status"],
    createdAt: tunnel.created_at ?? "",
    deletedAt: tunnel.deleted_at,
    // SDK Connection is a subset of our type; the client only reads
    // presence/count so the cast is safe.
    connections: (tunnel.connections ?? []) as CloudflareTunnelInfo["connections"],
  };
  if (includeDetails) {
    base.connectorId = extended.connector_id;
    base.activeTunnelConnections = tunnel.connections?.length ?? 0;
    base.metadata = {
      config_src: extended.config_src,
      remote_config: extended.remote_config,
    };
  }
  return base;
}

const addHostnameSchema = z.object({
  hostname: z
    .string()
    .min(1, "Hostname is required")
    .refine(
      (hostname) => {
        // Basic hostname validation — allows wildcard subdomains (`*.foo`).
        const hostnameRegex =
          /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
        return hostnameRegex.test(hostname) || hostname.startsWith("*.");
      },
      { message: "Invalid hostname format" },
    ),
  service: z
    .string()
    .min(1, "Service is required")
    .refine(
      (service) => {
        // Accept full URLs (http://, https://) or host:port shorthand like `localhost:3000`.
        try {
          new URL(service);
          return true;
        } catch {
          return (
            /^[a-zA-Z0-9.-]+:\d+$/.test(service) ||
            /^https?:\/\//.test(service)
          );
        }
      },
      { message: "Invalid service URL format" },
    ),
  path: z.string().optional(),
});

export function createCloudflareTunnelsRouter(
  cloudflareConfigService: CloudflareService,
): express.Router {
  const router = express.Router();

  const requireCreds = requireCloudflareCredentials(cloudflareConfigService);

  router.get(
    "/",
    requirePermission("settings:read") as RequestHandler,
    requireCreds,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);

      const cached = tunnelCache.getList();
      if (cached) {
        logger.debug(
          { requestId, userId, tunnelCount: cached.length },
          "Returning cached tunnel list",
        );
        const response: CloudflareTunnelListResponse = {
          success: true,
          data: { tunnels: cached, tunnelCount: cached.length },
        };
        return res.json(response);
      }

      const tunnels = await cloudflareConfigService.getTunnelInfo();
      const transformed = tunnels
        .filter((tunnel: TunnelListResponse) => !tunnel.deleted_at)
        .map((tunnel) => toTunnelInfo(tunnel));

      tunnelCache.setList(transformed);

      logger.debug(
        { requestId, userId, tunnelCount: transformed.length },
        "Cloudflare tunnels retrieved successfully",
      );

      const response: CloudflareTunnelListResponse = {
        success: true,
        data: { tunnels: transformed, tunnelCount: transformed.length },
      };
      res.json(response);
    }),
  );

  router.get(
    "/:id",
    requirePermission("settings:read") as RequestHandler,
    requireCreds,
    asyncHandler(async (req, res) => {
      const tunnelId = String(req.params.id);

      const cached = tunnelCache.getTunnel(tunnelId);
      if (cached) {
        const response: CloudflareTunnelDetailsResponse = {
          success: true,
          data: cached,
        };
        return res.json(response);
      }

      // We list all tunnels (including deleted) to match the previous
      // behaviour where callers could still look up a recently-deleted
      // tunnel by ID — useful during cleanup flows.
      const tunnels = await cloudflareConfigService.runner.run<TunnelListResponse[]>(
        {
          label: "tunnel list by id",
          logContext: { tunnelId },
        },
        async ({ cf, accountId }) => {
          const response = await cf.zeroTrust.tunnels.list({
            account_id: accountId,
          });
          return response.result ?? [];
        },
      );

      const tunnel = tunnels.find((t: TunnelListResponse) => t.id === tunnelId);
      if (!tunnel) {
        return res.status(404).json({
          success: false,
          error: "Tunnel not found",
          details: `Tunnel with ID ${tunnelId} was not found`,
        });
      }

      const transformed = toTunnelInfo(tunnel, true);
      tunnelCache.setTunnel(tunnelId, transformed);

      const response: CloudflareTunnelDetailsResponse = {
        success: true,
        data: transformed,
      };
      res.json(response);
    }),
  );

  router.get(
    "/:id/config",
    requirePermission("settings:read") as RequestHandler,
    requireCreds,
    asyncHandler(async (req, res) => {
      const tunnelId = String(req.params.id);

      const cached = tunnelCache.getConfig(tunnelId);
      if (cached) {
        const response: CloudflareTunnelConfigResponse = {
          success: true,
          data: cached,
        };
        return res.json(response);
      }

      const tunnelConfig =
        await cloudflareConfigService.getTunnelConfig(String(tunnelId));

      if (!tunnelConfig) {
        return res.status(404).json({
          success: false,
          error: "Tunnel configuration not found",
          details: `Configuration for tunnel ${tunnelId} was not found or could not be retrieved`,
        });
      }

      tunnelCache.setConfig(tunnelId, tunnelConfig);

      const response: CloudflareTunnelConfigResponse = {
        success: true,
        data: tunnelConfig,
      };
      res.json(response);
    }),
  );

  router.post(
    "/:id/hostnames",
    requirePermission("settings:write") as RequestHandler,
    requireCreds,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const userId = getUserId(req);
      const tunnelId = String(req.params.id);

      const validation = addHostnameSchema.safeParse(req.body);
      if (!validation.success) {
        logger.warn(
          {
            requestId,
            userId,
            tunnelId,
            errors: validation.error.flatten(),
          },
          "Invalid add hostname request",
        );
        return res.status(400).json({
          success: false,
          error: "Invalid request parameters",
          details: validation.error.flatten(),
        });
      }

      const { hostname, service, path } = validation.data;

      const updatedConfig = await cloudflareConfigService.addHostname(
        String(tunnelId),
        hostname,
        service,
        path,
      );

      if (!updatedConfig) {
        return res.status(500).json({
          success: false,
          error: "Failed to update tunnel configuration",
          details: "Unable to add hostname to tunnel",
        });
      }

      // Best-effort DNS CNAME — the ingress rule is the source of truth,
      // so we don't fail the request if DNS setup misbehaves.
      try {
        await cloudflareDNSService.upsertCNAMERecord(
          hostname,
          String(tunnelId),
        );
        logger.debug(
          { requestId, hostname, tunnelId },
          "DNS CNAME record created for tunnel hostname",
        );
      } catch (dnsError) {
        logger.warn(
          {
            requestId,
            hostname,
            tunnelId,
            error:
              dnsError instanceof Error ? dnsError.message : "Unknown error",
          },
          "Failed to create DNS CNAME record for tunnel hostname — ingress rule was added successfully",
        );
      }

      tunnelCache.clear();

      res.json({
        success: true,
        data: {
          tunnelId,
          hostname,
          service,
          path,
          configVersion: updatedConfig.version,
        },
      });
    }),
  );

  router.delete(
    "/:id/hostnames/:hostname",
    requirePermission("settings:write") as RequestHandler,
    requireCreds,
    asyncHandler(async (req, res) => {
      const requestId = req.headers["x-request-id"] as string;
      const tunnelId = String(req.params.id);
      const rawHostname = String(req.params.hostname);
      const { path } = req.query;

      // Hostnames may contain characters that need URL-encoding on the wire;
      // decode so we compare against the stored form.
      const decodedHostname = decodeURIComponent(rawHostname);

      const updatedConfig = await cloudflareConfigService.removeHostname(
        String(tunnelId),
        decodedHostname,
        path as string | undefined,
      );

      if (!updatedConfig) {
        return res.status(500).json({
          success: false,
          error: "Failed to update tunnel configuration",
          details: "Unable to remove hostname from tunnel",
        });
      }

      try {
        await cloudflareDNSService.deleteCNAMEByHostname(decodedHostname);
      } catch (dnsError) {
        logger.warn(
          {
            requestId,
            hostname: decodedHostname,
            tunnelId,
            error:
              dnsError instanceof Error ? dnsError.message : "Unknown error",
          },
          "Failed to delete DNS CNAME record for tunnel hostname — ingress rule was removed successfully",
        );
      }

      tunnelCache.clear();

      res.json({
        success: true,
        data: {
          tunnelId,
          hostname: decodedHostname,
          path,
          configVersion: updatedConfig.version,
        },
      });
    }),
  );

  return router;
}
