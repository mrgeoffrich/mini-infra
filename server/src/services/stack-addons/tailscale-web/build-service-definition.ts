import type {
  ProvisionContext,
  SidecarProvisionedValues,
  StackServiceDefinition,
} from '@mini-infra/types';
import { buildTailscaleSidecarDefinition } from '../shared/tailscale-sidecar';
import type { TailscaleSidecarMount } from './serve-config';

/**
 * Materialise the synthetic sidecar `StackServiceDefinition` for the
 * `tailscale-web` addon. The image, state volume, capabilities, and
 * control-plane egress all come from the shared helper; this function only
 * varies the env (incl. `TS_SERVE_CONFIG`), the rendered `serve.json` config
 * file, the matching mount the sidecar reads it from, and the addon-id
 * labels.
 */
export function buildTailscaleWebServiceDefinition(
  ctx: ProvisionContext,
  provisioned: SidecarProvisionedValues,
): StackServiceDefinition {
  const serveConfigMount = provisioned.templateVars.serveConfigMount as
    | TailscaleSidecarMount
    | undefined;
  return buildTailscaleSidecarDefinition({
    ctx,
    env: { ...(provisioned.envForSidecar ?? {}) },
    files: provisioned.files ?? [],
    extraMounts: serveConfigMount ? [serveConfigMount] : [],
    labels: {
      'mini-infra.addon': 'tailscale-web',
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': ctx.service.name,
    },
  });
}
