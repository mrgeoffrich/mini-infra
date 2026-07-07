import { z } from 'zod';
import type { AddonManifest } from '@mini-infra/types';

/**
 * Hostname discriminator inserted between `envName` and the optional
 * `instanceId` segment by `sanitizeTailscaleHostname`. Distinguishes the
 * `claude-shell` env-injection addon's tailnet device from a
 * `tailscale-ssh` / `tailscale-web` sidecar's device on the same target
 * service (review #3). Single source of truth — the provision path emits it
 * via `TS_HOSTNAME` and the Connect-panel endpoint route reconstructs the
 * same string. Must stay short and `[a-z0-9-]+` so it survives sanitisation
 * with no chars dropped.
 */
export const CLAUDE_SHELL_HOSTNAME_DISCRIMINATOR = 'shell';

/**
 * User-supplied config for the `claude-shell` addon.
 *
 * Both fields are optional — `addons: { 'claude-shell': {} }` is the minimum
 * viable form. The addon does not require any config to mint a key and bring
 * the device up on the tailnet; per-resource identity is encoded in the
 * device hostname computed at provision time via `sanitizeTailscaleHostname`
 * (the same helper `tailscale-ssh` uses).
 *
 * `gitRepo` is optional and, when present, is forwarded as `GIT_REPO_URL`
 * to the workload container. The Phase 1 entrypoint script consumes it to
 * clone the repo into `/workspace` on first start. Phase 5 adds the Vault
 * deploy-key path; until then, `gitRepo` only supports anonymously-cloneable
 * URLs (public HTTPS, etc.) — see §4.3 of the plan.
 *
 * `extraTags` is layered on top of the static `tag:mini-infra-managed`
 * default. Each tag must already exist in the operator's ACL `tagOwners`;
 * we never ask the operator to declare dynamic per-stack tags because
 * Tailscale's OAuth client policy gates that at the tailnet level.
 */
export const claudeShellConfigSchema = z
  .object({
    /**
     * Optional git repo URL to clone into the workspace volume on first
     * start. Plain string, validated only as a non-empty URL-ish shape —
     * the entrypoint script and (eventually) git itself enforce the real
     * shape. Empty strings are rejected so a missing field stays a clear
     * "no clone".
     */
    gitRepo: z.string().min(1).max(1024).optional(),
    /**
     * Operator-supplied additional tags for the tailnet device. Each must
     * match Tailscale's strict `tag:[a-z0-9-]+` shape and must already
     * exist in the operator's ACL `tagOwners`. Empty / unspecified is the
     * common case and uses the default tag set only.
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

export type ClaudeShellConfig = z.infer<typeof claudeShellConfigSchema>;

/**
 * Manifest for the `claude-shell` env-injection addon (Phase 3 of the
 * Claude Shell plan).
 *
 * `mode: 'env-injection'` — the workload image (`mini-infra-claude-shell`)
 * bakes `tailscaled` into the container itself, so the framework merges
 * `TS_AUTHKEY` / `TS_HOSTNAME` / `TS_EXTRA_ARGS` / etc. onto the target's
 * `containerConfig` rather than materialising a sidecar peer.
 *
 * `kind: 'claude-shell'` — its own kind, kept separate from the
 * `kind: 'tailscale'` group the sidecar-mode `tailscale-ssh` /
 * `tailscale-web` addons share. Env-injection addons don't participate in
 * `kind`-based merge groups (see `expand-addons.ts`), but giving this addon
 * its own kind keeps future expansion (e.g. claude-shell + another
 * env-injection addon) clean.
 *
 * `appliesTo: ['Stateful', 'StatelessWeb']` — single-instance only. Pool
 * is out of scope per §3 of the plan; the addon mints a per-target
 * hostname, and pool instances need per-instance hostnames that the
 * `tailscale-ssh` Pool branch already handles.
 */
export const claudeShellManifest = {
  id: 'claude-shell',
  kind: 'claude-shell',
  mode: 'env-injection',
  description:
    'Inject Tailscale-SSH bootstrap env (authkey + hostname + --ssh) into a Claude Shell workload container. The image bakes tailscaled in-process; the addon does not materialise a sidecar. Requires the Tailscale connected service.',
  appliesTo: ['Stateful', 'StatelessWeb'],
  requiresConnectedService: 'tailscale',
  // Mirrors `claudeShellConfigSchema` above — the drift test in
  // `addon-catalog-schema-drift.test.ts` pins these field names to the
  // schema's keys.
  configFields: [
    {
      name: 'gitRepo',
      label: 'Git Repository',
      type: 'string',
      required: false,
      placeholder: 'https://github.com/owner/repo.git',
      help: 'Optional git repo URL cloned into the workspace volume on first start. Only anonymously-cloneable URLs are supported until deploy keys land.',
    },
    {
      name: 'extraTags',
      label: 'Extra Tags',
      type: 'string[]',
      required: false,
      placeholder: 'tag:dev-team',
      help: 'Additional Tailscale tags to apply to the device. Each must match tag:[a-z0-9-]+ and already exist in your ACL tagOwners.',
      pattern: '^tag:[a-z0-9-]+$',
    },
  ],
} as const satisfies AddonManifest;
