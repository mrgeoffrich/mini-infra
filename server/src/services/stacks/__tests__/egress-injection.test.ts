import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveEgressEnv, attachEgressNetworkIfNeeded } from '../egress-injection';

// The logger factory is mocked globally by setup-unit.ts.
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as any;

function buildPrisma(
  envRow: { egressGatewayIp: string | null } | null,
  egressResource: { name: string; metadata: unknown } | null = null,
) {
  return {
    environment: {
      findUnique: vi.fn().mockResolvedValue(envRow),
    },
    infraResource: {
      findFirst: vi.fn().mockResolvedValue(egressResource),
    },
  } as any;
}

// ---------------------------------------------------------------------------
// resolveEgressEnv
// ---------------------------------------------------------------------------

describe('resolveEgressEnv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns proxy env when env has gateway and egress InfraResource exists', async () => {
    const prisma = buildPrisma(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.16.0/24' } },
    );
    const env = await resolveEgressEnv(prisma, 'env-1', /* egressBypass */ false);
    expect(env).toEqual({
      HTTP_PROXY: 'http://egress-gateway:3128',
      HTTPS_PROXY: 'http://egress-gateway:3128',
      http_proxy: 'http://egress-gateway:3128',
      https_proxy: 'http://egress-gateway:3128',
      NO_PROXY: 'localhost,127.0.0.1,::1,127.0.0.0/8,172.30.16.0/24',
      no_proxy: 'localhost,127.0.0.1,::1,127.0.0.0/8,172.30.16.0/24',
    });
  });

  it('omits the bridge CIDR when egress InfraResource has no subnet metadata', async () => {
    const prisma = buildPrisma(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: null },
    );
    const env = await resolveEgressEnv(prisma, 'env-1', false);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,127.0.0.0/8');
  });

  it('returns empty when egressBypass is true (gateway service itself)', async () => {
    const prisma = buildPrisma({ egressGatewayIp: '172.30.16.3' });
    const env = await resolveEgressEnv(prisma, 'env-1', true);
    expect(env).toEqual({});
    // Bypass short-circuits before any DB lookup.
    expect(prisma.environment.findUnique).not.toHaveBeenCalled();
    expect(prisma.infraResource.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty for host-level stacks (no environmentId)', async () => {
    const prisma = buildPrisma(null);
    const env = await resolveEgressEnv(prisma, null, false);
    expect(env).toEqual({});
    expect(prisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('returns empty when env has no egressGatewayIp (gateway not provisioned)', async () => {
    const prisma = buildPrisma({ egressGatewayIp: null });
    const env = await resolveEgressEnv(prisma, 'env-1', false);
    expect(env).toEqual({});
    expect(prisma.infraResource.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty when egress InfraResource is missing', async () => {
    const prisma = buildPrisma({ egressGatewayIp: '172.30.16.3' }, null);
    const env = await resolveEgressEnv(prisma, 'env-1', false);
    expect(env).toEqual({});
  });

  it('returns empty (never throws) when prisma lookup fails', async () => {
    const prisma = {
      environment: {
        findUnique: vi.fn().mockRejectedValue(new Error('db down')),
      },
      infraResource: {
        findFirst: vi.fn(),
      },
    } as any;
    const env = await resolveEgressEnv(prisma, 'env-1', false);
    expect(env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// attachEgressNetworkIfNeeded
// ---------------------------------------------------------------------------

describe('attachEgressNetworkIfNeeded', () => {
  beforeEach(() => vi.clearAllMocks());

  function buildContainerManager() {
    return {
      connectToNetwork: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('connects the container to the egress network when all gates pass', async () => {
    const prisma = buildPrisma(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.16.0/24' } },
    );
    const cm = buildContainerManager();

    await attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', false, log);

    expect(cm.connectToNetwork).toHaveBeenCalledWith('container-1', 'env1-egress');
  });

  it('skips connect when egressBypass=true', async () => {
    const prisma = buildPrisma({ egressGatewayIp: '172.30.16.3' });
    const cm = buildContainerManager();

    await attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', true, log);

    expect(cm.connectToNetwork).not.toHaveBeenCalled();
    expect(prisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('skips connect for host-level stacks', async () => {
    const prisma = buildPrisma(null);
    const cm = buildContainerManager();

    await attachEgressNetworkIfNeeded(prisma, cm, 'container-1', null, false, log);

    expect(cm.connectToNetwork).not.toHaveBeenCalled();
  });

  it('skips connect when env has no egressGatewayIp', async () => {
    const prisma = buildPrisma({ egressGatewayIp: null });
    const cm = buildContainerManager();

    await attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', false, log);

    expect(cm.connectToNetwork).not.toHaveBeenCalled();
  });

  it('skips connect when egress InfraResource is missing', async () => {
    const prisma = buildPrisma({ egressGatewayIp: '172.30.16.3' }, null);
    const cm = buildContainerManager();

    await attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', false, log);

    expect(cm.connectToNetwork).not.toHaveBeenCalled();
  });

  it('treats "already exists" as success (idempotent)', async () => {
    const prisma = buildPrisma(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.16.0/24' } },
    );
    const cm = {
      connectToNetwork: vi.fn().mockRejectedValue(
        Object.assign(new Error('endpoint with name container-1 already exists in network env1-egress'), { statusCode: 403 }),
      ),
    };

    // Should not throw.
    await expect(
      attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', false, log),
    ).resolves.toBeUndefined();
  });

  it('logs a warning but does not throw on unexpected connect failure', async () => {
    const prisma = buildPrisma(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.16.0/24' } },
    );
    const cm = {
      connectToNetwork: vi.fn().mockRejectedValue(new Error('docker daemon unreachable')),
    };

    await expect(
      attachEgressNetworkIfNeeded(prisma, cm, 'container-1', 'env-1', false, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
