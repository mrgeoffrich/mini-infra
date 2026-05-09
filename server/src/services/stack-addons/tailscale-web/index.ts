import type { AddonDefinition } from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import {
  tailscaleWebConfigSchema,
  tailscaleWebManifest,
  tailscaleWebTargetIntegration,
} from './manifest';
import { provisionTailscaleWeb } from './provision';
import { buildTailscaleWebServiceDefinition } from './build-service-definition';

/**
 * `tailscale-web` addon — Phase 4 sibling to `tailscale-ssh`. Materialises a
 * tailscaled sidecar running `tailscale serve` so the target service is
 * reachable at `https://<service>-<env>.<tailnet>.ts.net` with auto-issued
 * Let's Encrypt certs and no port forwarding. Shares `kind: tailscale` with
 * `tailscale-ssh` — when both are declared on the same service the merge
 * strategy collapses them into one sidecar.
 */
export const tailscaleWebDefinition: AddonDefinition = {
  manifest: tailscaleWebManifest,
  targetIntegration: tailscaleWebTargetIntegration,
  provision: provisionTailscaleWeb,
  buildServiceDefinition: buildTailscaleWebServiceDefinition,
};

export const tailscaleWebAddon: RegisteredAddon = {
  manifest: tailscaleWebManifest,
  configSchema: tailscaleWebConfigSchema,
  definition: tailscaleWebDefinition,
};

productionAddonRegistry.register(tailscaleWebAddon);
