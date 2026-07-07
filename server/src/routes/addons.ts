import { Router } from "express";
import { asyncHandler } from "../lib/async-handler";
import { requirePermission } from "../middleware/auth";
import { getLogger } from "../lib/logger-factory";
import {
  Permission,
  type AddonCatalogEntry,
  type AddonCatalogResponse,
} from "@mini-infra/types";
// IMPORTANT: import from the `stack-addons` BARREL (index.ts), not from
// `stack-addons/registry`. The production registry is populated purely by the
// barrel's side-effect imports (`import './tailscale-ssh'` etc.). Importing
// `registry.ts` directly would give an EMPTY registry and this endpoint would
// return `{ addons: [] }`. The integration test asserts a non-empty list to
// guard exactly this.
import {
  productionAddonRegistry,
  type RegisteredAddon,
} from "../services/stack-addons";

const logger = getLogger("integrations", "addons-route");

const router = Router();

/**
 * Project a registered addon into its serialisable catalog entry. `mode`
 * defaults to `'sidecar'` (the framework default when a manifest omits it,
 * matching `AddonManifest.mode`'s contract) and `configFields` defaults to
 * `[]` for addons that take no config.
 */
function toCatalogEntry(addon: RegisteredAddon): AddonCatalogEntry {
  const { manifest } = addon;
  return {
    id: manifest.id,
    description: manifest.description,
    kind: manifest.kind,
    mode: manifest.mode ?? "sidecar",
    appliesTo: manifest.appliesTo,
    requiresConnectedService: manifest.requiresConnectedService,
    configFields: manifest.configFields ?? [],
  };
}

/**
 * GET /api/addons
 *
 * Registry-driven catalog of every registered Service Addon, projected into
 * the serialisable `AddonCatalogEntry` shape (§4.1 of the addon-authoring-ui
 * plan) the client renders a picker + per-addon config form from. A newly
 * registered addon appears here automatically with no client-side change.
 *
 * Gated by `stacks:read` — the same read scope the sibling
 * `GET /api/stacks/:stackId/addon-endpoints` route uses.
 */
router.get(
  "/",
  requirePermission(Permission.StacksRead),
  asyncHandler(async (_req, res) => {
    const addons = productionAddonRegistry.list().map(toCatalogEntry);
    logger.debug({ count: addons.length }, "Serving addon catalog");
    const response: AddonCatalogResponse = { addons };
    res.json(response);
  }),
);

export default router;
