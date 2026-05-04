import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  type ProvisionContext,
  type ProvisionedValues,
  type StackServiceDefinition,
} from '@mini-infra/types';

/**
 * The official Tailscale image. We run containerised `tailscaled` rather
 * than embedding `tsnet` because `tsnet` is Go-only and the addon ships as
 * a sidecar container, not a library inside the Node process. The image
 * reads `TS_AUTHKEY`, `TS_HOSTNAME`, `TS_STATE_DIR`, and `TS_EXTRA_ARGS`
 * from env at boot.
 */
const TAILSCALE_IMAGE = 'tailscale/tailscale';
const TAILSCALE_TAG = 'stable';

const STATE_VOLUME_MOUNT_PATH = '/var/lib/tailscale';

/**
 * Materialise the synthetic sidecar `StackServiceDefinition` for the
 * `tailscale-ssh` addon. Inputs come from `provision()` (authkey + hostname
 * env), the addon's static target integration, and the static control-plane
 * `requiredEgress` constants from lib/.
 */
export function buildTailscaleSshServiceDefinition(
  ctx: ProvisionContext,
  provisioned: ProvisionedValues,
): StackServiceDefinition {
  const sidecarServiceName = `${ctx.service.name}-tailscale`;
  // Per-application state volume — Tailscale persists node identity here so
  // restarts re-use the same device record (when `ephemeral: false`); with
  // `ephemeral: true` the node de-registers on shutdown and the volume just
  // holds tailscaled's runtime state for the lifetime of the container.
  const stateVolumeName = `${sidecarServiceName}-state`;

  return {
    serviceName: sidecarServiceName,
    serviceType: 'Stateful',
    dockerImage: TAILSCALE_IMAGE,
    dockerTag: TAILSCALE_TAG,
    containerConfig: {
      env: {
        ...(provisioned.envForSidecar ?? {}),
      },
      // `tailscaled` requires NET_ADMIN to bring up its userspace networking
      // device, plus access to /dev/net/tun for kernel-mode networking. We
      // run in kernel mode (TS_USERSPACE=false from provision) for best
      // performance; the cap is needed regardless so the daemon can
      // configure routes when SSH sessions traverse subnets.
      capAdd: ['NET_ADMIN', 'SYS_MODULE'],
      mounts: [
        {
          source: stateVolumeName,
          target: STATE_VOLUME_MOUNT_PATH,
          type: 'volume',
        },
      ],
      labels: {
        'mini-infra.addon': 'tailscale-ssh',
        'mini-infra.synthetic': 'true',
        'mini-infra.addon-target': ctx.service.name,
      },
      restartPolicy: 'unless-stopped',
      // Tailscale control-plane and DERP relay hostnames — the sidecar must
      // reach these for tailscaled to come up. The egress-policy reconciler
      // picks them up as template-sourced rules in firewalled envs (§4.7),
      // so the addon works without manual policy edits.
      requiredEgress: [...TAILSCALE_CONTROL_PLANE_HOSTNAMES],
    },
    dependsOn: [ctx.service.name],
    // High order so synthetic sidecars come up after authored services in
    // the reconciler's create sequence — gives the target a head start on
    // its DNS registration.
    order: 1000,
  };
}
