import type { SidecarAddonDefinition, ProvisionContext } from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import {
  tailscaleWebConfigSchema,
  tailscaleWebManifest,
  tailscaleWebTargetIntegration,
} from './manifest';
import { provisionTailscaleWeb } from './provision';
import { buildTailscaleWebServiceDefinition } from './build-service-definition';
import { buildTailscaleSidecarDefinition } from '../shared/tailscale-sidecar';

/**
 * `tailscale-web` addon — Phase 4 sibling to `tailscale-ssh`. Materialises a
 * tailscaled sidecar running `tailscale serve` so the target service is
 * reachable at `https://<stack>-<service>-<env>.<tailnet>.ts.net` with auto-issued
 * Let's Encrypt certs and no port forwarding. Shares `kind: tailscale` with
 * `tailscale-ssh` — when both are declared on the same service the merge
 * strategy collapses them into one sidecar.
 */
export const tailscaleWebDefinition: SidecarAddonDefinition = {
  manifest: tailscaleWebManifest,
  targetIntegration: tailscaleWebTargetIntegration,
  provision: provisionTailscaleWeb,
  buildServiceDefinition: buildTailscaleWebServiceDefinition,
  // Plan-time skeleton — see tailscale-ssh's planStub for rationale. The
  // serve-config file mount and TS_SERVE_CONFIG env land at apply time;
  // the plan-time stub just carries the deterministic sidecar identity.
  planStub: (ctx: ProvisionContext) =>
    buildTailscaleSidecarDefinition({
      ctx,
      env: {},
      labels: {
        'mini-infra.addon': 'tailscale-web',
        'mini-infra.synthetic': 'true',
        'mini-infra.addon-target': ctx.service.name,
      },
    }),
};

export const tailscaleWebAddon: RegisteredAddon = {
  manifest: tailscaleWebManifest,
  configSchema: tailscaleWebConfigSchema,
  definition: tailscaleWebDefinition,
};

productionAddonRegistry.register(tailscaleWebAddon);
