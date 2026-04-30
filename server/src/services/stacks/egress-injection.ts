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
 * Never throws — egress injection failure must not break stack apply.
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
  } catch {
    return { shouldInject: false };
  }
}

const PROXY_URL = 'http://egress-gateway:3128';

function buildProxyEnv(subnet: string | undefined): Record<string, string> {
  const noProxy = ['localhost', '127.0.0.0/8', ...(subnet ? [subnet] : [])].join(',');
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
    const e = err as { message?: string; statusCode?: number };
    const msg = e?.message || '';
    if (!msg.includes('already exists') && e?.statusCode !== 403) {
      log.warn(
        { containerId, network: ctx.networkName, error: msg },
        'Failed to attach container to egress network',
      );
    }
  }
}
