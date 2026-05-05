import { z } from 'zod';
import type { AddonManifest, TargetIntegration } from '@mini-infra/types';

/**
 * User-supplied config for the `tailscale-ssh` addon. Both fields are
 * optional — `addons: { tailscale-ssh: {} }` is the minimum viable form.
 *
 * `extraTags` is layered on top of the static `tag:mini-infra-managed` that
 * the operator already assigned to their OAuth client in Phase 2; the addon
 * never asks the operator for the default tag because the connected service
 * owns it. Per-resource identity is encoded in the device hostname (see
 * `sanitizeTailscaleHostname`), not in dynamic tags — Tailscale OAuth clients
 * can only mint keys with tags pre-declared in the operator's ACL
 * `tagOwners`, so dynamic per-stack/per-env/per-service tags would force
 * unbounded ACL edits.
 */
export const tailscaleSshConfigSchema = z
  .object({
    /**
     * Operator-supplied additional tags. Each must match the strict
     * `tag:[a-z0-9-]+` shape Tailscale enforces and must already exist in
     * the operator's ACL `tagOwners`. Empty / unspecified is the common
     * case and uses the default tag set only.
     */
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

export type TailscaleSshConfig = z.infer<typeof tailscaleSshConfigSchema>;

export const tailscaleSshManifest: AddonManifest = {
  id: 'tailscale-ssh',
  kind: 'tailscale',
  description:
    'Operator SSH into the target service via Tailscale identity. Materialises a tailscaled sidecar joined to the target container, gated by the tailnet ACL ssh check policy.',
  appliesTo: ['Stateful', 'StatelessWeb', 'Pool'],
  requiresConnectedService: 'tailscale',
};

export const tailscaleSshTargetIntegration: TargetIntegration = {
  // Sidecar joins the same Docker network as the target and reaches it by
  // service-name DNS. The target itself is unmodified — no `network_mode`
  // rewrite, no port reclamation. SSH sessions land inside the sidecar
  // (where `tailscale up --ssh` runs the ssh server) and the sidecar can
  // talk to the target by name on the shared bridge network.
  network: 'peer-on-target-network',
};
