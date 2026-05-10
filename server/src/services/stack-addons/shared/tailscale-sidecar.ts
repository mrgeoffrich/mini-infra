import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  type ProvisionContext,
  type StackConfigFile,
  type StackContainerConfig,
  type StackServiceDefinition,
} from '@mini-infra/types';
import {
  tailscaleSidecarServiceName,
  tailscaleStateVolumeName,
} from './sidecar-naming';

type SidecarMount = NonNullable<StackContainerConfig['mounts']>[number];

/**
 * Official Tailscale image. We run containerised `tailscaled` rather than
 * embedding `tsnet` because `tsnet` is Go-only and the addon ships as a
 * sidecar container, not a library inside the Node process.
 */
const TAILSCALE_IMAGE = 'tailscale/tailscale';
const TAILSCALE_TAG = 'stable';

const STATE_VOLUME_MOUNT_PATH = '/var/lib/tailscale';

/**
 * Inputs shared between the solo addons and the `kind: tailscale` merge
 * strategy. The caller supplies the env, optional files (e.g. `serve.json`),
 * and the labels that distinguish solo vs merged sidecars; the helper owns
 * the image, capabilities, state-volume mount, restart policy, dependsOn,
 * order, and the Tailscale control-plane `requiredEgress` set.
 */
export interface BuildTailscaleSidecarInput {
  ctx: ProvisionContext;
  env: Record<string, string>;
  /** Optional config files (e.g. rendered `serve.json` for `tailscale-web`). */
  files?: StackConfigFile[];
  /**
   * Mounts beyond the always-on state volume — e.g. the config-file volume
   * holding `serve.json` for `tailscale-web`. Without these, a file in
   * `files` is written into a volume the sidecar never mounts and
   * tailscaled can't read it.
   */
  extraMounts?: SidecarMount[];
  /** Synthetic-marker labels — vary by solo addon vs merged group. */
  labels: Record<string, string>;
}

/**
 * Materialise the common sidecar `StackServiceDefinition` for a Tailscale
 * addon (solo or merged). Single source of truth for the image, capability
 * set, state-volume mount, restart policy, dependsOn, order, and the
 * control-plane `requiredEgress` list — so future changes (e.g. a pinned
 * image tag, an extra control-plane hostname) only land in one place.
 */
export function buildTailscaleSidecarDefinition(
  input: BuildTailscaleSidecarInput,
): StackServiceDefinition {
  const instanceId = input.ctx.instance?.instanceId;
  const sidecarServiceName = tailscaleSidecarServiceName(
    input.ctx.service.name,
    instanceId,
  );

  // Pool-instance addon sidecars skip the persistent state volume — pool
  // instances are short-lived, authkeys are minted per-spawn with
  // `ephemeral: true`, and the tailnet auto-cleans the device on shutdown.
  // The state volume would persist write-only across reaps and accumulate
  // one orphan volume per spawn, with no read-side benefit. Static-service
  // sidecars keep the volume so a restart re-uses the same device record.
  const mounts: NonNullable<StackServiceDefinition['containerConfig']['mounts']> = [
    ...(instanceId
      ? []
      : [
          {
            source: tailscaleStateVolumeName(sidecarServiceName),
            target: STATE_VOLUME_MOUNT_PATH,
            type: 'volume' as const,
          },
        ]),
    ...(input.extraMounts ?? []),
  ];

  const def: StackServiceDefinition = {
    serviceName: sidecarServiceName,
    serviceType: 'Stateful',
    dockerImage: TAILSCALE_IMAGE,
    dockerTag: TAILSCALE_TAG,
    containerConfig: {
      env: { ...input.env },
      // tailscaled requires NET_ADMIN to bring up its userspace networking
      // device, plus access to /dev/net/tun for kernel-mode networking. We
      // run in kernel mode (TS_USERSPACE=false) for best performance.
      capAdd: ['NET_ADMIN', 'SYS_MODULE'],
      mounts,
      labels: { ...input.labels },
      restartPolicy: 'unless-stopped',
      // Tailscale control-plane and DERP relay hostnames — the sidecar must
      // reach these for tailscaled to come up. The egress-policy reconciler
      // picks them up as template-sourced rules in firewalled envs.
      requiredEgress: [...TAILSCALE_CONTROL_PLANE_HOSTNAMES],
    },
    dependsOn: [input.ctx.service.name],
    // High order so synthetic sidecars come up after authored services in
    // the reconciler's create sequence — gives the target a head start on
    // its DNS registration.
    order: 1000,
  };

  if (input.files && input.files.length > 0) {
    def.configFiles = [...input.files];
  }

  return def;
}
