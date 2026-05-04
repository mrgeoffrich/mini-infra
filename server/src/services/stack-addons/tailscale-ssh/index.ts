import type { AddonDefinition } from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import {
  tailscaleSshConfigSchema,
  tailscaleSshManifest,
  tailscaleSshTargetIntegration,
} from './manifest';
import { provisionTailscaleSsh } from './provision';
import { buildTailscaleSshServiceDefinition } from './build-service-definition';

/**
 * `tailscale-ssh` addon — the first production addon in the framework
 * (Phase 3 of the Service Addons plan). Registered into the production
 * registry on import; tests opt out by constructing their own registry via
 * `createAddonRegistry()` and choosing what to register into it.
 */
export const tailscaleSshDefinition: AddonDefinition = {
  manifest: tailscaleSshManifest,
  targetIntegration: tailscaleSshTargetIntegration,
  provision: provisionTailscaleSsh,
  buildServiceDefinition: buildTailscaleSshServiceDefinition,
};

export const tailscaleSshAddon: RegisteredAddon = {
  manifest: tailscaleSshManifest,
  configSchema: tailscaleSshConfigSchema,
  definition: tailscaleSshDefinition,
};

// Self-register on import. `productionAddonRegistry` is the singleton the
// render pipeline reads from when an `addons:` block is present on a stack
// service. Importing this module from anywhere on the server (e.g. an
// `import './services/stack-addons/tailscale-ssh'` from the bootstrap) is
// sufficient to make the addon live.
productionAddonRegistry.register(tailscaleSshAddon);
