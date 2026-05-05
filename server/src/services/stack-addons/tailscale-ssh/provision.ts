import {
  TAILSCALE_DEFAULT_TAG,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type ProvisionContext,
  type ProvisionedValues,
} from '@mini-infra/types';
import { TailscaleAuthkeyMinter } from '../../tailscale/tailscale-authkey-minter';
import { TailscaleService } from '../../tailscale/tailscale-service';
import type { TailscaleSshConfig } from './manifest';

/**
 * Connected-service lookup the addon framework hands into `provision()`.
 * The addon expects the Tailscale connected service to be locatable under
 * the `tailscale` key — the apply route builds the lookup before invoking
 * `expandAddons`. Typed loosely (`unknown` → narrow on read) so the lib
 * stays runtime-dep-free; this is the server-side narrowing surface.
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
 * Mint a one-time, ephemeral, preauthorized Tailscale authkey for the
 * sidecar that's about to be materialised, and compute the device hostname
 * the sidecar will register under.
 *
 * The default `tag:mini-infra-managed` is always present (asserted by the
 * authkey minter); operator-supplied `extraTags` are merged on top via the
 * shared lib helper. Per-resource identity rides on the device hostname
 * (`<service>-<env>` sanitised, ≤63 chars), not on dynamic per-resource tags
 * — Tailscale OAuth clients can only mint keys with tags pre-declared in
 * the operator's ACL `tagOwners`, so dynamic tagging is infeasible.
 */
export async function provisionTailscaleSsh(
  ctx: ProvisionContext,
): Promise<ProvisionedValues> {
  const config = ctx.addonConfig as TailscaleSshConfig;
  const lookup = asLookup(ctx.connectedServices);
  const tailscale = lookup.tailscale;
  if (!tailscale) {
    throw new Error(
      'tailscale-ssh addon requires the Tailscale connected service to be configured',
    );
  }

  // Hostname rule: `{service}-{env}` sanitised, ≤63 chars. For the rare
  // case of a host-level stack (no environment) we fall back to the service
  // name alone — which still encodes per-resource identity because there's
  // only one host scope.
  const envSlug = ctx.environment.name && ctx.environment.name.length > 0
    ? ctx.environment.name
    : 'host';
  const hostname = sanitizeTailscaleHostname(ctx.service.name, envSlug);

  const minter = new TailscaleAuthkeyMinter(tailscale);
  const tagSet = buildTailscaleTagSet(config.extraTags ?? []);
  const authkey = await minter.mintAuthkey({
    tags: tagSet,
    ephemeral: true,
    preauthorized: true,
    reusable: false,
  });

  return {
    envForSidecar: {
      TS_AUTHKEY: authkey.key,
      TS_HOSTNAME: hostname,
      TS_STATE_DIR: '/var/lib/tailscale',
      TS_USERSPACE: 'false',
      // `--ssh` enables the in-process ssh server backed by the tailnet ACL
      // `ssh` stanza configured in Phase 2. `tailscale/tailscale` reads
      // TS_EXTRA_ARGS at boot and appends to its `tailscale up` invocation.
      TS_EXTRA_ARGS: '--ssh',
    },
    templateVars: {
      tailscaleHostname: hostname,
      tailscaleTags: tagSet,
      tailscaleDefaultTag: TAILSCALE_DEFAULT_TAG,
    },
  };
}
