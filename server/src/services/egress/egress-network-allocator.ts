import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'egress-network-allocator');

/**
 * Default CIDR pool for egress gateway subnets.
 * Override with MINI_INFRA_EGRESS_POOL_CIDR env var (e.g. "10.100.0.0/16").
 * Per-environment subnets are allocated as /<hostBits>-sized slices, default /24.
 */
const DEFAULT_POOL_CIDR = '172.30.0.0/16';
const DEFAULT_SUBNET_MASK = 24;

/**
 * Parse the pool CIDR from env, falling back to the default.
 * Returns { baseOctets: [a, b, c, d], poolMask, subnetMask }.
 */
function getPoolConfig(): { base: number[]; poolMask: number; subnetMask: number } {
  const raw = process.env['MINI_INFRA_EGRESS_POOL_CIDR'] ?? DEFAULT_POOL_CIDR;
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!match) {
    log.warn({ raw }, 'MINI_INFRA_EGRESS_POOL_CIDR is malformed, using default');
    return { base: [172, 30, 0, 0], poolMask: 16, subnetMask: DEFAULT_SUBNET_MASK };
  }
  const base = [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    parseInt(match[4], 10),
  ];
  const poolMask = parseInt(match[5], 10);
  const subnetMask = DEFAULT_SUBNET_MASK;
  if (poolMask > subnetMask) {
    log.warn({ poolMask, subnetMask }, 'Pool mask is larger than subnet mask, using default pool');
    return { base: [172, 30, 0, 0], poolMask: 16, subnetMask: DEFAULT_SUBNET_MASK };
  }
  return { base, poolMask, subnetMask };
}

/**
 * Convert a /24 subnet index to the corresponding CIDR network address string.
 * For pool 172.30.0.0/16 with /24 subnets: index 0 → "172.30.0.0/24", index 1 → "172.30.1.0/24", etc.
 *
 * Subnets are always /24, so the 4th octet of the network address is always 0.
 * The index selects successive /24 blocks starting from the pool base address.
 */
function indexToSubnet(index: number, base: number[], subnetMask: number): string {
  // Convert the base address to a 32-bit integer
  const baseInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  // Each /24 block is 256 addresses
  const blockSize = 1 << (32 - subnetMask);
  const subnetInt = (baseInt + index * blockSize) >>> 0;
  const o0 = (subnetInt >>> 24) & 0xff;
  const o1 = (subnetInt >>> 16) & 0xff;
  const o2 = (subnetInt >>> 8) & 0xff;
  const o3 = subnetInt & 0xff;
  return `${o0}.${o1}.${o2}.${o3}/${subnetMask}`;
}

/**
 * Derive the gateway IP from a subnet CIDR.
 * By convention the gateway occupies .1 in the subnet network address.
 * e.g. "172.30.5.0/24" → "172.30.5.1"
 */
function subnetToGatewayIp(subnet: string): string {
  const cidr = subnet.split('/')[0];
  const parts = cidr.split('.').map(Number);
  parts[3] = 1;
  return parts.join('.');
}

/**
 * The egress gateway container IP — second host address (.2) in the subnet.
 * e.g. "172.30.5.0/24" → "172.30.5.2"
 */
function subnetToGatewayContainerIp(subnet: string): string {
  const cidr = subnet.split('/')[0];
  const parts = cidr.split('.').map(Number);
  parts[3] = 2;
  return parts.join('.');
}

/**
 * Determine how many /24 slots exist in a pool of size poolMask bits.
 * For /16 → 256 subnets (x.y.0.0 to x.y.255.0); for /8 → 65536.
 */
function poolSlotCount(poolMask: number, subnetMask: number): number {
  const bits = subnetMask - poolMask;
  if (bits <= 0) return 1;
  return Math.min(1 << bits, 65536); // Cap at 65536 to avoid absurd loops
}

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
 * EgressNetworkAllocator picks deterministic, non-conflicting /24 subnets
 * and gateway IPs from the egress pool for environment applications networks.
 */
export class EgressNetworkAllocator {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Picks the lowest unused /24 from the configured pool.
   * - Pool default: 172.30.0.0/16, allocated as 172.30.<x>.0/24 for x in [0..255].
   * - Excludes subnets already stored in EnvironmentNetwork.options.subnet.
   * - Excludes subnets in use by existing Docker networks (cross-check via DockerService).
   *
   * Returns { subnet, gateway } where gateway is the .1 address (the bridge gateway).
   * The egress container itself will be allocated .2 separately via allocateGatewayIp().
   */
  async allocateSubnet(): Promise<{ subnet: string; gateway: string }> {
    const { base, poolMask, subnetMask } = getPoolConfig();
    const totalSlots = poolSlotCount(poolMask, subnetMask);

    // Collect subnets already in use from the DB.
    // Subnets are persisted on InfraResource.metadata.subnet for docker-network/applications resources.
    const dbResources = await this.prisma.infraResource.findMany({
      where: { type: 'docker-network', purpose: 'applications', scope: 'environment' },
      select: { metadata: true },
    });

    const usedFromDb = new Set<string>();
    for (const r of dbResources) {
      const meta = r.metadata as Record<string, unknown> | null;
      const subnet = meta?.['subnet'];
      if (typeof subnet === 'string') {
        // Normalise to just the network address for comparison
        const addr = parseCidrNetworkAddress(subnet);
        if (addr) usedFromDb.add(addr.join('.'));
      }
    }

    // Collect subnets in use by Docker (cross-check via DockerService)
    const usedFromDocker = new Set<string>();
    try {
      const docker = DockerService.getInstance();
      if (docker.isConnected()) {
        const networks = await docker.listNetworks();
        for (const net of networks) {
          for (const cfg of net.ipam?.config ?? []) {
            if (!cfg.subnet) continue;
            const addr = parseCidrNetworkAddress(cfg.subnet);
            if (addr) usedFromDocker.add(addr.join('.'));
          }
        }
      }
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Could not query Docker networks for subnet conflict check; proceeding with DB-only check');
    }

    // Pick the lowest unused slot
    for (let i = 0; i < totalSlots; i++) {
      const candidate = indexToSubnet(i, base, subnetMask);
      const addr = parseCidrNetworkAddress(candidate);
      if (!addr) continue;
      const addrStr = addr.join('.');
      if (usedFromDb.has(addrStr) || usedFromDocker.has(addrStr)) continue;

      const gateway = subnetToGatewayIp(candidate);
      log.info({ subnet: candidate, gateway, slot: i }, 'Allocated egress subnet');
      return { subnet: candidate, gateway };
    }

    throw new Error(
      `Egress subnet pool exhausted: all ${totalSlots} slots in the pool are in use. ` +
      `Override MINI_INFRA_EGRESS_POOL_CIDR to use a larger pool.`
    );
  }

  /**
   * For an applications network already created with a known subnet, pick the gateway
   * container IP (lowest unused host address >= .2 in that subnet).
   * Validates against currently connected containers on that network via Docker inspect.
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
        where: { type: 'docker-network', purpose: 'applications', scope: 'environment', name: networkName },
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

/**
 * Helper: derive the egress container IP from a known subnet.
 * This is the .2 address — used when creating the gateway stack service.
 * Callers should prefer allocateGatewayIp() for correctness; this is for testing.
 */
export function egressContainerIpFromSubnet(subnet: string): string {
  return subnetToGatewayContainerIp(subnet);
}
