import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type EnvInjectionProvisionedValues,
  type ProvisionContext,
} from '@mini-infra/types';
import { TailscaleAuthkeyMinter } from '../../tailscale/tailscale-authkey-minter';
import { TailscaleService } from '../../tailscale/tailscale-service';
import type { ClaudeShellConfig } from './manifest';

/**
 * Connected-service lookup the addon framework hands into `provision()`.
 * Same shape `tailscale-ssh`'s provision uses — typed loosely on the
 * framework side (`unknown`) and narrowed here on the server-side.
 */
interface AddonConnectedServicesLookup {
  tailscale?: TailscaleService;
}

function asLookup(input: unknown): AddonConnectedServicesLookup {
  if (input && typeof input === 'object') {
    return input as AddonConnectedServicesLookup;
  }
  return {};
}

/**
 * Mint an authkey for the workload container's in-process tailscaled and
 * compute the hostname under which the device registers on the tailnet.
 *
 * Unlike `tailscale-ssh`, this addon runs in env-injection mode — the
 * provisioned env / caps / devices / egress land on the workload's
 * `containerConfig` directly. The image's entrypoint (Phase 1) reads the
 * env and runs `tailscaled` + `tailscale up --hostname=... --ssh` in the
 * same container as Claude Code.
 *
 * Hostname identity follows the same `{stack}-{service}-{env}` triple
 * `tailscale-ssh` uses so two stacks that share a `(service, env)` name
 * still produce distinct tailnet devices. Pool instances aren't supported
 * here (manifest's `appliesTo` excludes `Pool`).
 *
 * Required egress carries the Tailscale control-plane hostnames so the
 * env's egress-firewall reconciler opens the right holes without manual
 * policy edits — same precedent as the `tailscale-ssh` / `tailscale-web`
 * sidecars.
 *
 * Capabilities + devices: tailscaled needs `NET_ADMIN` + `SYS_MODULE`
 * (capabilities) and `/dev/net/tun` (device) to bring up kernel-mode
 * networking. The sidecar precedent is `shared/tailscale-sidecar.ts`,
 * which sets the same caps on the sidecar peer; here we set them on the
 * target instead, since the target runs tailscaled itself.
 *
 * `GIT_SSH_KEY` is NOT emitted here — Phase 5 plumbs the Vault deploy-key
 * path. The entrypoint already handles `GIT_SSH_KEY` being absent (it just
 * skips writing the key and the clone will fail/skip for private repos,
 * which is the correct behaviour for Phase 3 — public repos clone fine).
 */
export async function provisionClaudeShell(
  ctx: ProvisionContext,
): Promise<EnvInjectionProvisionedValues> {
  const config = ctx.addonConfig as ClaudeShellConfig;
  const lookup = asLookup(ctx.connectedServices);
  const tailscale = lookup.tailscale;
  if (!tailscale) {
    throw new Error(
      'claude-shell addon requires the Tailscale connected service to be configured',
    );
  }

  // Hostname rule: `{stack}-{service}-{env}` sanitised, ≤63 chars. The
  // manifest's `appliesTo` excludes `Pool`, so we deliberately do not
  // thread `ctx.instance?.instanceId` through — a `claude-shell` addon on
  // a pool service would have been rejected at applicability time.
  const envSlug =
    ctx.environment.name && ctx.environment.name.length > 0
      ? ctx.environment.name
      : 'host';
  const hostname = sanitizeTailscaleHostname(
    ctx.stack.name,
    ctx.service.name,
    envSlug,
  );

  // Best-effort cleanup of stale offline registrations on this hostname —
  // same precedent as `tailscale-ssh` / `tailscale-web` provision paths.
  await tailscale.purgeStaleManagedDevicesByHostname(hostname);

  const minter = new TailscaleAuthkeyMinter(tailscale);
  const tagSet = buildTailscaleTagSet(config.extraTags ?? []);
  const authkey = await minter.mintAuthkey({
    tags: tagSet,
    ephemeral: true,
    preauthorized: true,
    reusable: false,
  });

  // Build the env block. `GIT_REPO_URL` is conditional — emitting an empty
  // string would still pass the entrypoint's `[[ -n "${GIT_REPO_URL:-}" ]]`
  // check is false (so it's fine functionally), but keeping the key absent
  // means the rendered containerConfig.env stays stable across provision
  // calls when the operator doesn't set a repo, which keeps the
  // definition-hash deterministic.
  const envForTarget: Record<string, string> = {
    TS_AUTHKEY: authkey.key,
    TS_HOSTNAME: hostname,
    TS_EXTRA_ARGS: '--ssh',
    TS_STATE_DIR: '/var/lib/tailscale',
  };
  if (config.gitRepo) {
    envForTarget.GIT_REPO_URL = config.gitRepo;
  }

  return {
    mode: 'env-injection',
    envForTarget,
    // The `mini-infra.addon: 'claude-shell'` label is applied unconditionally
    // by the framework (see `expand-addons.ts#applyEnvInjectionGroup`) for
    // endpoint-discovery purposes — we don't duplicate it here.
    requiredEgress: [...TAILSCALE_CONTROL_PLANE_HOSTNAMES],
    capAddForTarget: ['NET_ADMIN', 'SYS_MODULE'],
    devicesForTarget: ['/dev/net/tun'],
    templateVars: {
      tailscaleHostname: hostname,
      tailscaleTags: tagSet,
    },
  };
}
