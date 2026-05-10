import { Router } from "express";
import prisma from "../../lib/prisma";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission } from "../../middleware/auth";
import { TailscaleDeviceStatusScheduler } from "../../services/tailscale";
import { getLogger } from "../../lib/logger-factory";
import {
  sanitizeTailscaleHostname,
  type StackDefinition,
  type StackServiceDefinition,
  type TailscaleAddonEndpoint,
  type TailscaleAddonEndpointsResponse,
} from "@mini-infra/types";

const logger = getLogger("integrations", "stacks-addon-endpoints-route");

const router = Router();

interface TailscaleWebAddonConfig {
  port?: number;
  path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the operator-authored target service for a synthetic Tailscale
 * sidecar. The sidecar's `synthetic.targetService` is the canonical link;
 * fall back to the labels emitted by the addon framework
 * (`mini-infra.addon-target`) when the snapshot was written by a build
 * that didn't yet stamp `synthetic`.
 */
function findTargetService(
  service: StackServiceDefinition,
): string | null {
  if (service.synthetic?.targetService) return service.synthetic.targetService;
  const labels = service.containerConfig?.labels;
  if (labels && typeof labels === "object") {
    const raw = (labels as Record<string, unknown>)["mini-infra.addon-target"];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return null;
}

/**
 * Pull the `tailscale-web` addon config off the *target* service so the
 * Connect panel can render the right URL path. The sidecar's container
 * config doesn't carry `port`/`path` directly — those live on the user's
 * authored `addons['tailscale-web']` block on the target.
 */
function readWebConfig(
  snapshot: StackDefinition,
  targetServiceName: string,
): TailscaleWebAddonConfig | null {
  const target = snapshot.services.find(
    (s) => s.serviceName === targetServiceName,
  );
  if (!target?.addons) return null;
  const raw = (target.addons as Record<string, unknown>)["tailscale-web"];
  if (!isRecord(raw)) return null;
  return {
    port: typeof raw.port === "number" ? raw.port : undefined,
    path: typeof raw.path === "string" ? raw.path : undefined,
  };
}

function deriveEndpoints(
  snapshot: StackDefinition,
  envName: string,
  tailnet: string | null,
): TailscaleAddonEndpoint[] {
  const endpoints: TailscaleAddonEndpoint[] = [];
  const envSlug = envName.length > 0 ? envName : "host";

  for (const service of snapshot.services) {
    const synth = service.synthetic;
    if (!synth) continue;

    // Pre-`synthetic` stamping branches (and any other addon kinds) get
    // skipped — Phase 5 only surfaces tailnet endpoints.
    const isTailscale =
      synth.kind === "tailscale" ||
      synth.addonIds.some((id) => id === "tailscale-ssh" || id === "tailscale-web");
    if (!isTailscale) continue;

    const targetService = findTargetService(service);
    if (!targetService) continue;

    const hostname = sanitizeTailscaleHostname(targetService, envSlug);
    const fqdn = tailnet ? `${hostname}.${tailnet}` : null;

    if (synth.addonIds.includes("tailscale-ssh")) {
      endpoints.push({
        targetService,
        syntheticServiceName: service.serviceName,
        addonIds: synth.addonIds,
        kind: "ssh",
        hostname,
        url: fqdn ? `ssh root@${fqdn}` : null,
      });
    }

    if (synth.addonIds.includes("tailscale-web")) {
      const cfg = readWebConfig(snapshot, targetService);
      const path = cfg?.path && cfg.path !== "/" ? cfg.path : "";
      endpoints.push({
        targetService,
        syntheticServiceName: service.serviceName,
        addonIds: synth.addonIds,
        kind: "https",
        hostname,
        url: fqdn ? `https://${fqdn}${path}` : null,
      });
    }
  }

  // Stable sort: target service alphabetical, ssh before https within a target.
  endpoints.sort((a, b) => {
    if (a.targetService !== b.targetService) {
      return a.targetService.localeCompare(b.targetService);
    }
    return a.kind === b.kind ? 0 : a.kind === "ssh" ? -1 : 1;
  });

  return endpoints;
}

/**
 * GET /:stackId/addon-endpoints
 *
 * Returns the list of addon-derived endpoints (currently SSH + HTTPS via
 * Tailscale) for a stack. URLs are formatted server-side so the
 * `<host>.<tailnet>.ts.net` pattern lives in one place.
 *
 * Returns `endpoints: []` when:
 *   - the stack has no Tailscale addons attached,
 *   - the stack has not been applied yet (no `lastAppliedSnapshot`), or
 *   - Tailscale is not configured (no scheduler running).
 */
router.get(
  "/:stackId/addon-endpoints",
  requirePermission("stacks:read"),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: {
        environment: { select: { name: true } },
      },
    });

    if (!stack) {
      return res
        .status(404)
        .json({ success: false, message: "Stack not found" });
    }

    const snapshot = stack.lastAppliedSnapshot as StackDefinition | null;
    if (!snapshot) {
      const empty: TailscaleAddonEndpointsResponse = { endpoints: [] };
      return res.json(empty);
    }

    const scheduler = TailscaleDeviceStatusScheduler.getInstance();
    const tailnet = scheduler?.getSnapshot().tailnet ?? null;

    let endpoints: TailscaleAddonEndpoint[];
    try {
      endpoints = deriveEndpoints(
        snapshot,
        stack.environment?.name ?? "",
        tailnet,
      );
    } catch (err) {
      logger.warn(
        { err, stackId },
        "Failed to derive Tailscale addon endpoints (returning empty list)",
      );
      endpoints = [];
    }

    const response: TailscaleAddonEndpointsResponse = { endpoints };
    res.json(response);
  }),
);

export default router;
