import {
  TAILSCALE_DEFAULT_TAG,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type AddonMergeStrategy,
  type ProvisionContext,
  type ProvisionedValues,
  type StackConfigFile,
  type StackServiceDefinition,
  type TargetIntegration,
} from '@mini-infra/types';
import { TailscaleAuthkeyMinter } from '../../tailscale/tailscale-authkey-minter';
import { TailscaleService } from '../../tailscale/tailscale-service';
import { getLogger } from '../../../lib/logger-factory';
import { buildTailscaleSidecarDefinition } from '../shared/tailscale-sidecar';
import {
  TAILSCALE_SERVE_CONFIG_PATH,
  buildServeConfigArtifacts,
  renderServeJson,
  type TailscaleSidecarMount,
} from '../tailscale-web/serve-config';
import type { TailscaleSshConfig } from '../tailscale-ssh/manifest';
import type { TailscaleWebConfig } from '../tailscale-web/manifest';

const TAILSCALE_KIND = 'tailscale';

interface AddonConnectedServicesLookup {
  tailscale?: TailscaleService;
}

function asLookup(input: unknown): AddonConnectedServicesLookup {
  if (input && typeof input === 'object') {
    return input as AddonConnectedServicesLookup;
  }
  return {};
}

interface ResolvedMembers {
  ssh?: TailscaleSshConfig;
  web?: TailscaleWebConfig;
  /** Union of every member's `extraTags`, deduped, in declaration order. */
  extraTags: string[];
}

function resolveMembers(
  members: ReadonlyArray<{ addonId: string; config: unknown }>,
): ResolvedMembers {
  const result: ResolvedMembers = { extraTags: [] };
  const seenTags = new Set<string>();
  for (const m of members) {
    if (m.addonId === 'tailscale-ssh') {
      result.ssh = (m.config ?? {}) as TailscaleSshConfig;
    } else if (m.addonId === 'tailscale-web') {
      result.web = (m.config ?? {}) as TailscaleWebConfig;
    } else {
      // Future Tailscale-kind addons land here; for now refuse to merge an
      // unknown member rather than silently dropping it from the rendered
      // sidecar.
      throw new Error(
        `Unknown member "${m.addonId}" for kind:"tailscale" merge group`,
      );
    }
    const config = (m.config ?? {}) as { extraTags?: string[] };
    for (const tag of config.extraTags ?? []) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        result.extraTags.push(tag);
      }
    }
  }
  return result;
}

/**
 * Provision a single tailnet device for the merged group: one authkey, one
 * hostname, one optional `serve.json` (only when `tailscale-web` is a
 * member). The merged env composes flags from each member — `TS_EXTRA_ARGS`
 * for `tailscale-ssh`'s `--ssh` and `TS_SERVE_CONFIG` for `tailscale-web`'s
 * `serve.json` — so the rendered sidecar runs both surfaces under one
 * tailscaled process.
 */
async function provisionTailscaleMerged(
  ctx: ProvisionContext,
  members: ReadonlyArray<{ addonId: string; config: unknown }>,
): Promise<ProvisionedValues> {
  const resolved = resolveMembers(members);
  const lookup = asLookup(ctx.connectedServices);
  const tailscale = lookup.tailscale;
  if (!tailscale) {
    throw new Error(
      'kind:"tailscale" merge requires the Tailscale connected service to be configured',
    );
  }

  const envSlug =
    ctx.environment.name && ctx.environment.name.length > 0
      ? ctx.environment.name
      : 'host';
  const hostname = sanitizeTailscaleHostname(ctx.service.name, envSlug);

  // Best-effort cleanup of stale offline registrations on this hostname —
  // see the matching call in `tailscale-web/provision.ts` for the rationale.
  await tailscale.purgeStaleManagedDevicesByHostname(hostname);

  const tagSet = buildTailscaleTagSet(resolved.extraTags);
  const minter = new TailscaleAuthkeyMinter(tailscale);
  const authkey = await minter.mintAuthkey({
    tags: tagSet,
    ephemeral: true,
    preauthorized: true,
    reusable: false,
  });

  const env: Record<string, string> = {
    TS_AUTHKEY: authkey.key,
    TS_HOSTNAME: hostname,
    TS_STATE_DIR: '/var/lib/tailscale',
    TS_USERSPACE: 'false',
  };

  // tailscale-ssh contribution.
  if (resolved.ssh) {
    env.TS_EXTRA_ARGS = '--ssh';
  }

  // tailscale-web contribution.
  const files: StackConfigFile[] = [];
  let tailnetDomain: string | null = null;
  let targetPort: number | undefined;
  let targetPath: string | undefined;
  let serveConfigMount: TailscaleSidecarMount | undefined;
  if (resolved.web) {
    targetPort = resolved.web.port;
    targetPath = resolved.web.path ?? '/';
    env.TS_SERVE_CONFIG = TAILSCALE_SERVE_CONFIG_PATH;
    const serveJson = renderServeJson({
      targetService: ctx.service.name,
      targetPort: resolved.web.port,
      path: resolved.web.path,
    });
    const artifacts = buildServeConfigArtifacts(ctx.service.name, serveJson);
    files.push(artifacts.configFile);
    serveConfigMount = artifacts.configMount;
    try {
      tailnetDomain = await tailscale.getTailnetDomain();
    } catch (err) {
      getLogger('integrations', 'tailscale-merge-provision').warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to resolve tailnet MagicDNS suffix during merged provision',
      );
    }
  }

  return {
    envForSidecar: env,
    files,
    templateVars: {
      tailscaleHostname: hostname,
      tailscaleTags: tagSet,
      tailscaleDefaultTag: TAILSCALE_DEFAULT_TAG,
      tailnetDomain,
      mergedAddonIds: members.map((m) => m.addonId),
      ...(targetPort !== undefined ? { targetPort, targetPath } : {}),
      // Carried into buildServiceDefinition so the merged sidecar mounts the
      // serve.json volume. Without this, tailscaled boots with
      // TS_SERVE_CONFIG pointing at a non-existent path.
      ...(serveConfigMount ? { serveConfigMount } : {}),
    },
  };
}

function buildMergedServiceDefinition(
  ctx: ProvisionContext,
  provisioned: ProvisionedValues,
  members: ReadonlyArray<{ addonId: string; config: unknown }>,
): StackServiceDefinition {
  const memberIds = members.map((m) => m.addonId).sort();
  const serveConfigMount = provisioned.templateVars.serveConfigMount as
    | TailscaleSidecarMount
    | undefined;
  return buildTailscaleSidecarDefinition({
    ctx,
    env: { ...(provisioned.envForSidecar ?? {}) },
    files: provisioned.files ?? [],
    extraMounts: serveConfigMount ? [serveConfigMount] : [],
    labels: {
      // Merged sidecars are identified by their kind, not a specific addon
      // id — the AddonBadge falls back to `synthetic.kind` when present, so
      // this label keeps the container-list rendering in sync with the
      // service-row rendering for the merged case.
      'mini-infra.addon': TAILSCALE_KIND,
      'mini-infra.addon-kind': TAILSCALE_KIND,
      'mini-infra.addon-members': memberIds.join(','),
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': ctx.service.name,
    },
  });
}

const tailscaleMergedTargetIntegration: TargetIntegration = {
  // Both `tailscale-ssh` and `tailscale-web` use `peer-on-target-network` —
  // the merged sidecar inherits the same shape.
  network: 'peer-on-target-network',
};

function planStubMergedServiceDefinition(
  ctx: ProvisionContext,
  members: ReadonlyArray<{ addonId: string; config: unknown }>,
): StackServiceDefinition {
  // Mirror buildMergedServiceDefinition's labels exactly (sorted member ids)
  // so the plan-time synthetic identity matches the apply-time one. Per-mint
  // env (TS_AUTHKEY, TS_HOSTNAME, TS_EXTRA_ARGS, TS_SERVE_CONFIG) is omitted —
  // those values come from `provision()` and would change the synthetic's
  // hash on every plan run if included.
  const memberIds = members.map((m) => m.addonId).sort();
  return buildTailscaleSidecarDefinition({
    ctx,
    env: {},
    labels: {
      'mini-infra.addon': TAILSCALE_KIND,
      'mini-infra.addon-kind': TAILSCALE_KIND,
      'mini-infra.addon-members': memberIds.join(','),
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': ctx.service.name,
    },
  });
}

/**
 * Merge strategy for `kind: "tailscale"`. Collapses any combination of
 * `tailscale-ssh` and `tailscale-web` declared on the same target service
 * into a single tailscaled sidecar — one authkey, one hostname, one tailnet
 * device, one state volume, one rendered service row — sharing whichever of
 * `--ssh` and `TS_SERVE_CONFIG` the declared members ask for.
 */
export const tailscaleMergeStrategy: AddonMergeStrategy = {
  kind: TAILSCALE_KIND,
  targetIntegration: tailscaleMergedTargetIntegration,
  provision: provisionTailscaleMerged,
  buildServiceDefinition: buildMergedServiceDefinition,
  planStub: planStubMergedServiceDefinition,
};
