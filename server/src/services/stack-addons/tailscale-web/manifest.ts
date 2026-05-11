import { z } from 'zod';
import type { AddonManifest, TargetIntegration } from '@mini-infra/types';

/**
 * User-supplied config for the `tailscale-web` addon.
 *
 * `port` is required — it's the local port on the target service the sidecar
 * proxies to over the shared Docker network (the addon's
 * `targetIntegration.network` is `peer-on-target-network`, so the sidecar
 * reaches the target by service-name DNS).
 *
 * `path` defaults to `/`; an addon-config that wants to expose a sub-path
 * (`{ path: "/api" }`) is supported but the common case is `/`.
 *
 * `extraTags` mirrors the `tailscale-ssh` addon — operator-supplied tags must
 * already be declared in the tailnet's `tagOwners` ACL. The static
 * `tag:mini-infra-managed` is always added by the authkey minter.
 */
export const tailscaleWebConfigSchema = z
  .object({
    port: z
      .number()
      .int()
      .min(1)
      .max(65535),
    path: z
      .string()
      .regex(/^\//, 'path must begin with "/"')
      .optional(),
    extraTags: z
      .array(
        z
          .string()
          .regex(
            /^tag:[a-z0-9-]+$/,
            'tag must match tag:[a-z0-9-]+ (e.g. tag:dev-team)',
          ),
      )
      .optional(),
  })
  .strict();

export type TailscaleWebConfig = z.infer<typeof tailscaleWebConfigSchema>;

export const tailscaleWebManifest = {
  id: 'tailscale-web',
  kind: 'tailscale',
  // Explicit for clarity even though `sidecar` is the framework default — this
  // addon materialises a tailscaled peer container; the env-injection mode
  // added in Phase 2 of the claude-shell plan does NOT apply here.
  mode: 'sidecar',
  description:
    'Expose the target service over HTTPS on the tailnet with auto-provisioned TLS. Materialises a tailscaled sidecar running `tailscale serve` against ${TS_CERT_DOMAIN}:443 → http://<target>:<port>.',
  appliesTo: ['Stateful', 'StatelessWeb', 'Pool'],
  requiresConnectedService: 'tailscale',
} as const satisfies AddonManifest;

export const tailscaleWebTargetIntegration: TargetIntegration = {
  // Sidecar joins the same Docker network as the target. `tailscale serve`
  // proxies traffic from the tailnet to `http://<target>:<port>` resolved by
  // service-name DNS on the shared bridge network. The target itself is
  // unmodified — no `network_mode` rewrite, no port reclamation.
  network: 'peer-on-target-network',
};
