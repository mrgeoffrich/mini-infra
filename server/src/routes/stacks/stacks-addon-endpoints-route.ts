import { Router } from "express";
import prisma from "../../lib/prisma";
import { asyncHandler } from "../../lib/async-handler";
import { requirePermission } from "../../middleware/auth";
import { TailscaleDeviceStatusScheduler } from "../../services/tailscale";
import { getLogger } from "../../lib/logger-factory";
import {
  buildPoolHostnamePrefix,
  sanitizeTailscaleHostname,
  type StackDefinition,
  type StackServiceDefinition,
  type TailscaleAddonEndpoint,
  type TailscaleAddonEndpointsResponse,
} from "@mini-infra/types";
import { CLAUDE_SHELL_HOSTNAME_DISCRIMINATOR } from "../../services/stack-addons/claude-shell/manifest";

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

/**
 * Look up a target service's `serviceType` from the snapshot. The Connect
 * panel emits a *summary row* for pool targets rather than enumerating
 * per-instance endpoints — per-instance enumeration happens in the client's
 * drill-in Sheet via the live pool-instances pipeline, keeping this route a
 * pure snapshot read (no PoolInstance query).
 */
function isPoolTarget(snapshot: StackDefinition, targetServiceName: string): boolean {
  const target = snapshot.services.find((s) => s.serviceName === targetServiceName);
  return target?.serviceType === "Pool";
}

/**
 * Read the `mini-infra.addon` label off a service's `containerConfig.labels`.
 * Env-injection-mode addons (e.g. `claude-shell`) stamp this label onto the
 * *target* service so endpoint discovery can find them without scanning
 * manifests. Sidecar-mode addons stamp it onto the *synthetic* service,
 * which is the path the legacy synthetic-scan branch picks up — we ignore
 * those here to avoid double-counting.
 */
function readEnvInjectionAddonId(service: StackServiceDefinition): string | null {
  const labels = service.containerConfig?.labels;
  if (!labels || typeof labels !== "object") return null;
  // A synthetic service also carries `mini-infra.addon` — skip it; the
  // synthetic-scan branch above handles those endpoints.
  if (service.synthetic) return null;
  const raw = (labels as Record<string, unknown>)["mini-infra.addon"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// Exported for unit testing — the route handler still calls it locally.
export function deriveEndpoints(
  snapshot: StackDefinition,
  stackName: string,
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

    const targetIsPool = isPoolTarget(snapshot, targetService);

    // For pool targets the visible "hostname" on the row is the template form
    // (e.g. `web-svc-prod-{instance}`) — the client renders this verbatim,
    // computes per-instance hostnames in the Sheet via `buildPoolInstanceHostname`.
    // The non-pool path keeps the existing static-service behaviour.
    const hostname = targetIsPool
      ? `${buildPoolHostnamePrefix(stackName, targetService, envSlug)}-{instance}`
      : sanitizeTailscaleHostname(stackName, targetService, envSlug);
    const fqdn = tailnet ? `${hostname}.${tailnet}` : null;
    const poolFields = targetIsPool
      ? {
          isPool: true as const,
          poolHostnamePrefix: buildPoolHostnamePrefix(
            stackName,
            targetService,
            envSlug,
          ),
          tailnet,
          templateHostname: fqdn,
        }
      : {};

    if (synth.addonIds.includes("tailscale-ssh")) {
      endpoints.push({
        targetService,
        syntheticServiceName: service.serviceName,
        addonIds: synth.addonIds,
        kind: "ssh",
        hostname,
        url: targetIsPool ? null : fqdn ? `ssh root@${fqdn}` : null,
        ...poolFields,
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
        url: targetIsPool ? null : fqdn ? `https://${fqdn}${path}` : null,
        ...poolFields,
      });
    }
  }

  // Env-injection-mode addons (`claude-shell`) don't materialise a synthetic
  // service — they label the *target* service with `mini-infra.addon: <id>`
  // and merge their tailscaled env / caps / devices onto the target's
  // containerConfig. Discovery walks the same `snapshot.services` list but
  // keys off the label rather than `synthetic`.
  //
  // The hostname rule is identical to the sidecar path: the addon's
  // `provision()` calls `sanitizeTailscaleHostname(stackName, serviceName,
  // envSlug)`, and we recompute it here from the same inputs so the Connect
  // panel's hostname matches the tailnet device hostname exactly.
  for (const service of snapshot.services) {
    const addonId = readEnvInjectionAddonId(service);
    if (addonId !== "claude-shell") continue;

    // Pool targets aren't supported by `claude-shell` (manifest's
    // `appliesTo` excludes `Pool`), but guard defensively so a hand-crafted
    // snapshot that violates that invariant doesn't crash the route.
    if (service.serviceType === "Pool") continue;

    const hostname = sanitizeTailscaleHostname(
      stackName,
      service.serviceName,
      envSlug,
      { discriminator: CLAUDE_SHELL_HOSTNAME_DISCRIMINATOR },
    );
    const fqdn = tailnet ? `${hostname}.${tailnet}` : null;
    endpoints.push({
      targetService: service.serviceName,
      // Env-injection addons have no synthetic peer — reuse the target's
      // own name as the row's React-key suffix. The shape stays uniform
      // with the sidecar-mode endpoints the client already renders.
      syntheticServiceName: service.serviceName,
      addonIds: [addonId],
      kind: "ssh",
      hostname,
      url: fqdn ? `ssh root@${fqdn}` : null,
    });
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
        stack.name,
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
