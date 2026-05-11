import {
  TAILSCALE_DEFAULT_TAG,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type ProvisionContext,
  type SidecarProvisionedValues,
} from '@mini-infra/types';
import { TailscaleAuthkeyMinter } from '../../tailscale/tailscale-authkey-minter';
import { TailscaleService } from '../../tailscale/tailscale-service';
import { getLogger } from '../../../lib/logger-factory';
import {
  TAILSCALE_SERVE_CONFIG_PATH,
  buildServeConfigArtifacts,
  renderServeJson,
} from './serve-config';
import type { TailscaleWebConfig } from './manifest';

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
 * Mint the authkey, render `serve.json`, and resolve the tailnet domain for
 * the `tailscale-web` sidecar.
 *
 * The rendered `serve.json` uses the runtime-substituted `${TS_CERT_DOMAIN}`
 * so the file is invariant across tailnets — tailscaled fills the host in
 * when it boots. The tailnet domain we resolve here is best-effort and lands
 * in `templateVars.tailnetDomain` for downstream UI (Phase 5 Connect panel)
 * to compose a clickable URL without a separate API roundtrip; if the lookup
 * fails (e.g. MagicDNS disabled on the tailnet), we still ship the sidecar —
 * the runtime substitution carries the data plane.
 */
export async function provisionTailscaleWeb(
  ctx: ProvisionContext,
): Promise<SidecarProvisionedValues> {
  const config = ctx.addonConfig as TailscaleWebConfig;
  const lookup = asLookup(ctx.connectedServices);
  const tailscale = lookup.tailscale;
  if (!tailscale) {
    throw new Error(
      'tailscale-web addon requires the Tailscale connected service to be configured',
    );
  }

  const envSlug =
    ctx.environment.name && ctx.environment.name.length > 0
      ? ctx.environment.name
      : 'host';
  const hostname = sanitizeTailscaleHostname(
    ctx.stack.name,
    ctx.service.name,
    envSlug,
    ctx.instance?.instanceId,
  );

  // Best-effort: purge any *offline* managed device already squatting on
  // this hostname so the new registration takes the unsuffixed DNS name
  // instead of `<host>-1.<tailnet>.ts.net`. Online devices are left alone —
  // the provision path runs on every apply, so deleting a live device would
  // kick our own running sidecar off the tailnet.
  await tailscale.purgeStaleManagedDevicesByHostname(hostname);

  const minter = new TailscaleAuthkeyMinter(tailscale);
  const tagSet = buildTailscaleTagSet(config.extraTags ?? []);
  const authkey = await minter.mintAuthkey({
    tags: tagSet,
    ephemeral: true,
    preauthorized: true,
    reusable: false,
  });

  let tailnetDomain: string | null = null;
  try {
    tailnetDomain = await tailscale.getTailnetDomain();
  } catch (err) {
    // Best-effort — falling back to null leaves Phase 5 to either re-resolve
    // or surface a "domain unknown" placeholder. The data path is unaffected
    // because the rendered serve.json uses runtime-substituted
    // `${TS_CERT_DOMAIN}`.
    getLogger('integrations', 'tailscale-web-provision').warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to resolve tailnet MagicDNS suffix',
    );
  }

  const serveJson = renderServeJson({
    targetService: ctx.service.name,
    targetPort: config.port,
    path: config.path,
  });
  const { configFile, configMount } = buildServeConfigArtifacts(
    ctx.service.name,
    serveJson,
  );

  return {
    envForSidecar: {
      TS_AUTHKEY: authkey.key,
      TS_HOSTNAME: hostname,
      TS_STATE_DIR: '/var/lib/tailscale',
      TS_USERSPACE: 'false',
      TS_SERVE_CONFIG: TAILSCALE_SERVE_CONFIG_PATH,
    },
    files: [configFile],
    templateVars: {
      tailscaleHostname: hostname,
      tailscaleTags: tagSet,
      tailscaleDefaultTag: TAILSCALE_DEFAULT_TAG,
      tailnetDomain,
      targetPort: config.port,
      targetPath: config.path ?? '/',
      // Carried into buildServiceDefinition so the sidecar mounts the same
      // volume the configFile gets written into. Without this, tailscaled
      // boots with TS_SERVE_CONFIG pointing at a non-existent path.
      serveConfigMount: configMount,
    },
  };
}
