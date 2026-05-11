import type {
  ProvisionContext,
  SidecarProvisionedValues,
  StackServiceDefinition,
} from '@mini-infra/types';
import { buildTailscaleSidecarDefinition } from '../shared/tailscale-sidecar';

/**
 * Materialise the synthetic sidecar `StackServiceDefinition` for the
 * `tailscale-ssh` addon. The image, state volume, capabilities, and
 * control-plane egress all come from the shared helper; this function only
 * varies the env (incl. `TS_EXTRA_ARGS=--ssh`) and the addon-id labels.
 */
export function buildTailscaleSshServiceDefinition(
  ctx: ProvisionContext,
  provisioned: SidecarProvisionedValues,
): StackServiceDefinition {
  return buildTailscaleSidecarDefinition({
    ctx,
    env: { ...(provisioned.envForSidecar ?? {}) },
    labels: {
      'mini-infra.addon': 'tailscale-ssh',
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': ctx.service.name,
    },
  });
}
