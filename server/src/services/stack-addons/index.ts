// Service Addons framework — entry point for the render pipeline integration.
//
// Phase 1 ships the framework only; the production registry is empty so the
// render pass is a no-op for every existing stack. Per-addon directories
// (`tailscale-ssh/`, `tailscale-web/`, `caddy-auth/`) self-register into
// `productionAddonRegistry` starting Phase 3.

export {
  AddonRegistry,
  createAddonRegistry,
  productionAddonRegistry,
} from './registry';
export type { RegisteredAddon } from './registry';

export {
  expandAddons,
  AddonExpansionError,
} from './expand-addons';
export type { ExpansionContext, ExpansionProgress } from './expand-addons';
