/**
 * Egress proxy injection — env vars + network attach.
 *
 * Every managed container in an env-scoped stack that doesn't opt out via
 * `egressBypass: true` should both (a) receive HTTP_PROXY env pointing at
 * the per-env egress-gateway and (b) be attached to the per-env egress
 * Docker network so the `egress-gateway:3128` hostname actually resolves.
 *
 * The two halves were previously decided independently: env injection fired
 * whenever the env had `egressGatewayIp` set, but network attach was left to
 * stack templates to declare. Stacks that didn't happen to join the right
 * resource network ended up with proxy env pointing at an unresolvable
 * hostname — every outbound HTTPS call died at DNS resolution.
 *
 * This module collapses both decisions into a single set of gates so they
 * can't drift again.
 */
import type { Logger } from 'pino';
import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';

// Module-level logger for `resolveEgressContext`'s failure path — used by
// both `resolveEgressEnv` (no logger parameter) and `attachEgressNetworkIfNeeded`
// (which has its own caller-supplied `log: Logger` parameter, kept separate
// below so this module-level logger never shadows it).
const moduleLog = getLogger('stacks', 'egress-injection');

interface EgressContext {
  shouldInject: boolean;
  networkName?: string;
  subnet?: string;
}

/**
 * Resolve whether egress injection should fire for a managed container, and
 * the per-env egress network name + subnet if so.
 *
 * Gates (in order):
 * - egressBypass === true → no injection (egress-gateway itself, fw-agent, etc.)
 * - No environmentId → host-level stack, no injection.
 * - Environment has no egressGatewayIp → gateway not provisioned, skip.
 * - No `egress` InfraResource for the env → gateway provisioning incomplete, skip.
 *
 * Never throws — egress injection failure must not break stack apply. A
 * failure inside the try (a DB/lookup blip, as opposed to a deliberate gate
 * like "no egressGatewayIp yet") is surfaced as a structured warning rather
 * than silently swallowed (network overhaul defect F4) — a transient DB
 * error looks identical to "gateway not provisioned" to the caller, but
 * operators need to be able to tell the difference from the logs instead of
 * silently losing egress wiring for a container.
 */
async function resolveEgressContext(
  prisma: PrismaClient,
  environmentId: string | null | undefined,
  egressBypass: boolean,
): Promise<EgressContext> {
  if (egressBypass) return { shouldInject: false };
  if (!environmentId) return { shouldInject: false };

  try {
    const env = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { egressGatewayIp: true },
    });
    if (!env?.egressGatewayIp) return { shouldInject: false };

    const resource = await prisma.infraResource.findFirst({
      where: {
        type: 'docker-network',
        purpose: 'egress',
        scope: 'environment',
        environmentId,
      },
      select: { name: true, metadata: true },
    });
    if (!resource) return { shouldInject: false };

    const meta = resource.metadata as Record<string, unknown> | null;
    const subnet = typeof meta?.['subnet'] === 'string' ? (meta['subnet'] as string) : undefined;

    return { shouldInject: true, networkName: resource.name, subnet };
  } catch (err) {
    moduleLog.warn(
      {
        environmentId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Egress context resolution failed (DB/lookup blip) — egress env injection and network attach skipped for this container',
    );
    return { shouldInject: false };
  }
}

const PROXY_URL = 'http://egress-gateway:3128';

function buildProxyEnv(subnet: string | undefined): Record<string, string> {
  // BusyBox wget (used by alpine healthchecks) doesn't grok CIDR — it only
  // matches literal hostnames/IPs. Include explicit loopback literals so
  // localhost healthchecks bypass the proxy on minimal HTTP clients, and
  // keep the CIDR for libcurl/curl-style tools that do support it.
  const noProxy = ['localhost', '127.0.0.1', '::1', '127.0.0.0/8', ...(subnet ? [subnet] : [])].join(
    ',',
  );
  return {
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * Resolve the proxy env vars for a managed container. Returns an empty
 * record when any gate fails — callers can spread it unconditionally.
 *
 * Caller env vars from the service definition should be merged AFTER this
 * record so service overrides win.
 */
export async function resolveEgressEnv(
  prisma: PrismaClient,
  environmentId: string | null | undefined,
  egressBypass: boolean,
): Promise<Record<string, string>> {
  const ctx = await resolveEgressContext(prisma, environmentId, egressBypass);
  if (!ctx.shouldInject) return {};
  return buildProxyEnv(ctx.subnet);
}

/**
 * Attach a container to the per-env egress Docker network so it can resolve
 * `egress-gateway:3128`. Idempotent — already-connected is treated as success.
 *
 * No-op when any gate fails. Logs a warning on connect failure but never
 * throws (mirrors the resolveEgressEnv contract — egress wiring failures
 * must not break stack apply).
 */
export async function attachEgressNetworkIfNeeded(
  prisma: PrismaClient,
  containerManager: { connectToNetwork(containerId: string, networkName: string): Promise<void> },
  containerId: string,
  environmentId: string | null | undefined,
  egressBypass: boolean,
  log: Logger,
): Promise<void> {
  const ctx = await resolveEgressContext(prisma, environmentId, egressBypass);
  if (!ctx.shouldInject || !ctx.networkName) return;

  try {
    await containerManager.connectToNetwork(containerId, ctx.networkName);
    log.info({ containerId, network: ctx.networkName }, 'Attached container to egress network');
  } catch (err) {
    // connectToNetwork delegates to NetworkManager.connect(), which already
    // treats "already connected" as success (status-code driven, not message
    // matching) — anything reaching this catch is a genuine failure.
    log.warn(
      { containerId, network: ctx.networkName, error: err instanceof Error ? err.message : String(err) },
      'Failed to attach container to egress network',
    );
  }
}
