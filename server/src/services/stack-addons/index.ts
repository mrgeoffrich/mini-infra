// Service Addons framework — entry point for the render pipeline integration.
//
// Per-addon directories (`tailscale-ssh/`, `tailscale-web/`, `caddy-auth/`)
// self-register into `productionAddonRegistry` on import. This barrel
// imports them once so any consumer that imports from `./stack-addons`
// automatically gets the production registry populated.

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

// Side-effect imports — populate `productionAddonRegistry`.
import './tailscale-ssh';
