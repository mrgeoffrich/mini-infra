import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type EnvInjectionProvisionedValues,
  type ProvisionContext,
} from '@mini-infra/types';
import { TailscaleAuthkeyMinter } from '../../tailscale/tailscale-authkey-minter';
import { TailscaleService } from '../../tailscale/tailscale-service';
import { getLogger } from '../../../lib/logger-factory';
import {
  getVaultKVService,
  VaultKVError,
  type VaultKVService,
} from '../../vault/vault-kv-service';
import {
  CLAUDE_SHELL_HOSTNAME_DISCRIMINATOR,
  type ClaudeShellConfig,
} from './manifest';

const log = getLogger('stacks', 'claude-shell-provision');

/**
 * Vault KV path convention for the per-service git deploy key (plan §4.3).
 * Mirrored in `stacks-git-deploy-key-route.ts`; the convention lives in two
 * places intentionally — the route owns the write surface, the addon owns
 * the read surface, and both must agree without one importing the other's
 * module (the addon already has a tightly-scoped import surface).
 */
function buildGitDeployKeyPath(stackId: string, serviceName: string): string {
  return `stacks/${stackId}/services/${serviceName}/git-deploy-key`;
}

/**
 * Read the per-service git deploy key from Vault KV at apply time. Returns
 * `null` when the path is absent (no key configured for this service) or
 * when the path exists but has no `privateKey` field. Re-raises any other
 * Vault error so apply fails clearly when Vault is reachable but
 * permission-denied / sealed / etc.
 *
 * NEVER LOGS THE KEY MATERIAL. Logs the marker `present` / `absent` only.
 *
 * Exposed only via `provisionClaudeShell` — the KV service is passed in so
 * tests can stub it without touching the singleton.
 */
async function readGitDeployKey(
  kv: Pick<VaultKVService, 'read'>,
  stackId: string,
  serviceName: string,
): Promise<string | null> {
  const path = buildGitDeployKeyPath(stackId, serviceName);
  try {
    const data = await kv.read(path);
    if (data === null) {
      log.debug({ stackId, serviceName }, 'git-deploy-key: absent (no path)');
      return null;
    }
    const raw = (data as Record<string, unknown>).privateKey;
    if (typeof raw !== 'string' || raw.length === 0) {
      log.debug(
        { stackId, serviceName },
        'git-deploy-key: absent (path present but privateKey field missing/empty)',
      );
      return null;
    }
    log.info({ stackId, serviceName }, 'git-deploy-key: present (injecting GIT_SSH_KEY)');
    return raw;
  } catch (err) {
    if (err instanceof VaultKVError && err.code === 'path_not_found') {
      log.debug({ stackId, serviceName }, 'git-deploy-key: absent (path_not_found)');
      return null;
    }
    throw err;
  }
}

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
 * `GIT_SSH_KEY` is emitted when a per-service git deploy key has been
 * written to Vault at the path `stacks/${stackId}/services/${serviceName}/git-deploy-key`
 * (plan §4.3, Phase 5). The Phase 1 entrypoint handles the absence
 * gracefully so unauthenticated public-repo clones still work — for a
 * private repo the operator uploads the key via the
 * `/api/stacks/:stackId/services/:serviceName/git-deploy-key` route.
 *
 * Test seam: the optional second argument lets tests substitute a fake
 * VaultKVService so the addon can be exercised without standing up Vault.
 * Production callers leave it undefined and the singleton is used.
 */
export async function provisionClaudeShell(
  ctx: ProvisionContext,
  kvOverride?: Pick<VaultKVService, 'read'>,
): Promise<EnvInjectionProvisionedValues> {
  const config = ctx.addonConfig as ClaudeShellConfig;
  const lookup = asLookup(ctx.connectedServices);
  const tailscale = lookup.tailscale;
  if (!tailscale) {
    throw new Error(
      'claude-shell addon requires the Tailscale connected service to be configured',
    );
  }

  // Hostname rule: `{stack}-{service}-{env}-shell` sanitised, ≤63 chars.
  // The `-shell` discriminator distinguishes this addon's device from the
  // `tailscale-ssh` / `tailscale-web` sidecar-mode addons' devices on the
  // same target — without it, attaching both `tailscale-ssh` and
  // `claude-shell` to one service produces two devices with the same
  // hostname, Tailscale auto-renames one to `<host>-1`, and the Connect
  // panel's client-side hostname derivation no longer matches the actual
  // tailnet device (review #3). The manifest's `appliesTo` excludes
  // `Pool`, so `instanceId` is not threaded through.
  const envSlug =
    ctx.environment.name && ctx.environment.name.length > 0
      ? ctx.environment.name
      : 'host';
  const hostname = sanitizeTailscaleHostname(
    ctx.stack.name,
    ctx.service.name,
    envSlug,
    { discriminator: CLAUDE_SHELL_HOSTNAME_DISCRIMINATOR },
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

  // Phase 5: optional git deploy key from Vault. Reading the value at
  // provision time (rather than emitting a `dynamicEnv: { kind: 'vault-kv' }`
  // entry resolved later) keeps the addon's surface small — claude-shell
  // doesn't have a vaultAppRole binding, and the rest of the dynamicEnv
  // pipeline is structured around AppRole-bound services. The injector reads
  // through the same admin-token broker that resolves vault-kv dynamicEnv
  // entries, so the privilege model is unchanged.
  //
  // NEVER LOG OR ECHO THE KEY MATERIAL. `readGitDeployKey` only emits the
  // present/absent marker.
  const kv = kvOverride ?? getVaultKVService();
  const gitSshKey = await readGitDeployKey(kv, ctx.stack.id, ctx.service.name);
  if (gitSshKey) {
    envForTarget.GIT_SSH_KEY = gitSshKey;
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
