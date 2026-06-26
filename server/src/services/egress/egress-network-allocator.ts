import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'egress-network-allocator');

/**
 * Parse an IPv4 CIDR subnet string to its network address as an array of 4 octets.
 * Returns null if invalid or IPv6.
 */
function parseCidrNetworkAddress(cidr: string): number[] | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const octets = parts[0].split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
  return octets;
}

/**
 * EgressNetworkAllocator picks the gateway container IP for the per-env egress
 * network (where the egress-gateway container and managed app containers live).
 *
 * The network's subnet is chosen by Docker's IPAM at network-create time — the
 * allocator does not prescribe it (delegating to Docker is what keeps the
 * subnet from overlapping other networks on a shared host). The allocator's
 * only job is to pick the gateway container's host address within whatever
 * subnet Docker assigned.
 */
export class EgressNetworkAllocator {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * For the per-env egress network already created with a known subnet, pick
   * the gateway container IP (lowest unused host address >= .2 in that
   * subnet). Validates against currently connected containers on that
   * network via Docker inspect.
   *
   * @param networkName - Docker network name to inspect
   * @returns The IPv4 address the egress container should use
   */
  async allocateGatewayIp(networkName: string): Promise<string> {
    // First try to get the subnet from Docker network inspect
    let subnet: string | null = null;
    const usedIps = new Set<string>();

    try {
      const docker = DockerService.getInstance();
      if (docker.isConnected()) {
        const networks = await docker.listNetworks();
        const net = networks.find(n => n.name === networkName);
        if (net) {
          const firstConfig = net.ipam?.config?.[0];
          if (firstConfig?.subnet) {
            subnet = firstConfig.subnet;
          }
          // Collect IPs currently used by connected containers
          for (const container of net.containers ?? []) {
            if (container.ipv4Address) {
              usedIps.add(container.ipv4Address.split('/')[0]);
            }
          }
        }
      }
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err), networkName }, 'Could not inspect Docker network for gateway IP allocation');
    }

    if (!subnet) {
      // Fallback: look in InfraResource.metadata.subnet
      const resource = await this.prisma.infraResource.findFirst({
        where: { type: 'docker-network', purpose: 'egress', scope: 'environment', name: networkName },
        select: { metadata: true },
      });
      const meta = resource?.metadata as Record<string, unknown> | null;
      const storedSubnet = meta?.['subnet'];
      if (typeof storedSubnet === 'string') {
        subnet = storedSubnet;
      }
    }

    if (!subnet) {
      throw new Error(`Cannot allocate gateway IP: no subnet found for network "${networkName}"`);
    }

    const baseOctets = parseCidrNetworkAddress(subnet);
    if (!baseOctets) {
      throw new Error(`Cannot allocate gateway IP: subnet "${subnet}" is not a valid IPv4 CIDR`);
    }

    // Try .2, .3, .4, ... up to .254
    for (let hostPart = 2; hostPart <= 254; hostPart++) {
      const candidate = [...baseOctets.slice(0, 3), hostPart].join('.');
      if (!usedIps.has(candidate)) {
        log.info({ ip: candidate, networkName, subnet }, 'Allocated egress gateway IP');
        return candidate;
      }
    }

    throw new Error(
      `Egress gateway IP pool exhausted for network "${networkName}" subnet "${subnet}": all host addresses are in use`
    );
  }
}
