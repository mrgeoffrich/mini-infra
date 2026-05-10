import type { AddonDefinition, ProvisionContext } from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import {
  tailscaleSshConfigSchema,
  tailscaleSshManifest,
  tailscaleSshTargetIntegration,
} from './manifest';
import { provisionTailscaleSsh } from './provision';
import { buildTailscaleSshServiceDefinition } from './build-service-definition';
import { buildTailscaleSidecarDefinition } from '../shared/tailscale-sidecar';

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
  // Plan-time skeleton: the deterministic shape of the sidecar (image, capAdd,
  // state-volume mount, requiredEgress) without the per-mint env (TS_AUTHKEY,
  // TS_HOSTNAME, TS_EXTRA_ARGS — these land at apply time via `provision`).
  planStub: (ctx: ProvisionContext) =>
    buildTailscaleSidecarDefinition({
      ctx,
      env: {},
      labels: {
        'mini-infra.addon': 'tailscale-ssh',
        'mini-infra.synthetic': 'true',
        'mini-infra.addon-target': ctx.service.name,
      },
    }),
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
