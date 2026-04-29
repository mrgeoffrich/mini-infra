import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StackContainerManager } from '../stack-container-manager';
import type { StackServiceDefinition } from '@mini-infra/types';

// The logger factory is mocked globally by setup-unit.ts.

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

function makeService(overrides: Partial<StackServiceDefinition['containerConfig']> = {}): StackServiceDefinition {
  return {
    serviceName: 'web',
    serviceType: 'Stateful',
    dockerImage: 'myapp',
    dockerTag: 'latest',
    containerConfig: {
      env: {},
      ...overrides,
    },
    dependsOn: [],
    order: 1,
  };
}

function makeOptions(environmentId: string | null | undefined) {
  return {
    projectName: 'mystack',
    stackId: 'stack-1',
    stackName: 'mystack',
    stackVersion: 1,
    environmentId,
    definitionHash: 'abc123',
    networkNames: [],
  };
}

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockCreateLongRunningContainer = vi.fn();
const mockContainerStart = vi.fn().mockResolvedValue(undefined);

const mockDockerExecutor = {
  createLongRunningContainer: mockCreateLongRunningContainer,
  getDockerClient: vi.fn(),
  pullImageWithAutoAuth: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// Tests for Phase 3 HTTP_PROXY injection (egressFirewallEnabled = true)
// ---------------------------------------------------------------------------

describe('StackContainerManager — Phase 3 HTTP_PROXY injection (flag ON)', () => {
  let mockPrisma: any;
  let manager: StackContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLongRunningContainer.mockResolvedValue({
      id: 'container-new',
      start: mockContainerStart,
    });
  });

  function buildManager(
    envResult: { egressFirewallEnabled: boolean; egressGatewayIp: string | null } | null,
    infraResourceResult: { metadata: unknown } | null = null,
  ) {
    mockPrisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue(envResult),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(infraResourceResult),
      },
    };
    return new StackContainerManager(mockDockerExecutor, mockPrisma);
  }

  it('injects HTTP_PROXY env vars when egressFirewallEnabled=true', async () => {
    manager = buildManager(
      { egressFirewallEnabled: true, egressGatewayIp: null },
      { metadata: { subnet: '172.30.5.0/24' } },
    );
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['HTTPS_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['http_proxy']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['https_proxy']).toBe('http://egress-gateway:3128');
    // NO_PROXY includes localhost, loopback block, and bridge CIDR
    expect(callArgs.env['NO_PROXY']).toContain('localhost');
    expect(callArgs.env['NO_PROXY']).toContain('127.0.0.0/8');
    expect(callArgs.env['NO_PROXY']).toContain('172.30.5.0/24');
    expect(callArgs.env['no_proxy']).toBe(callArgs.env['NO_PROXY']);
    // DNS injection must NOT be present (we use Docker's default resolver)
    expect(callArgs.dnsServers).toBeUndefined();
  });

  it('includes NO_PROXY without bridge CIDR when subnet not found', async () => {
    manager = buildManager(
      { egressFirewallEnabled: true, egressGatewayIp: null },
      null, // no infra resource → no subnet
    );
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['NO_PROXY']).toContain('localhost');
    expect(callArgs.env['NO_PROXY']).toContain('127.0.0.0/8');
    // Should not crash, just omit the bridge CIDR
    expect(callArgs.dnsServers).toBeUndefined();
  });

  it('skips HTTP_PROXY injection when egressBypass=true (v3 gateway service)', async () => {
    manager = buildManager(
      { egressFirewallEnabled: true, egressGatewayIp: null },
    );
    const service = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('egress-gw', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
    expect(callArgs.env['HTTPS_PROXY']).toBeUndefined();
    expect(callArgs.dnsServers).toBeUndefined();
    // Prisma must not be called (bypass short-circuits before DB lookup)
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('skips HTTP_PROXY injection for host-level stacks (no environmentId)', async () => {
    manager = buildManager(null);
    const service = makeService();
    const options = makeOptions(null);

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
    expect(callArgs.dnsServers).toBeUndefined();
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('merges injected proxy env vars with static service env vars (service vars take precedence)', async () => {
    manager = buildManager(
      { egressFirewallEnabled: true, egressGatewayIp: null },
      { metadata: { subnet: '172.30.1.0/24' } },
    );
    // Service explicitly sets its own HTTP_PROXY (override)
    const service = makeService({ env: { HTTP_PROXY: 'http://custom-proxy:9090', APP_VAR: 'hello' } });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    // Service env takes precedence over injected env
    expect(callArgs.env['HTTP_PROXY']).toBe('http://custom-proxy:9090');
    expect(callArgs.env['APP_VAR']).toBe('hello');
    // Other proxy vars are still injected
    expect(callArgs.env['HTTPS_PROXY']).toBe('http://egress-gateway:3128');
  });
});

// ---------------------------------------------------------------------------
// Tests for legacy DNS injection (egressFirewallEnabled = false)
// ---------------------------------------------------------------------------

describe('StackContainerManager — Legacy DNS injection (flag OFF)', () => {
  let mockPrisma: any;
  let manager: StackContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLongRunningContainer.mockResolvedValue({
      id: 'container-new',
      start: mockContainerStart,
    });
  });

  function buildManager(envResult: { egressFirewallEnabled: boolean; egressGatewayIp: string | null } | null) {
    mockPrisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue(envResult),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    return new StackContainerManager(mockDockerExecutor, mockPrisma);
  }

  it('injects DNS servers when egressFirewallEnabled=false and egressGatewayIp is set', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: '10.100.0.2' });
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toEqual(['10.100.0.2']);
    // No HTTP_PROXY vars for legacy path
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
  });

  it('injects no DNS and does not throw when egressGatewayIp is null and flag is OFF', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: null });
    const service = makeService();
    const options = makeOptions('env-1');

    await expect(manager.createAndStartContainer('web', service, options)).resolves.toBeDefined();

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
  });

  it('injects no DNS when egressBypass=true (legacy TS sidecar)', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: '10.100.0.2' });
    const service = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('egress-gw', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    // Prisma must not be called
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('injects no DNS for host-level stack (no environmentId)', async () => {
    manager = buildManager(null);
    const service = makeService();
    const options = makeOptions(null);

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('injects DNS only for non-bypass services in the same stack', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: '10.100.0.5' });
    const options = makeOptions('env-1');

    const normalService = makeService({ egressBypass: false });
    const bypassService = makeService({ egressBypass: true });

    await manager.createAndStartContainer('app', normalService, options);
    await manager.createAndStartContainer('gw', bypassService, options);

    const firstCallArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    const secondCallArgs = mockCreateLongRunningContainer.mock.calls[1][0];

    expect(firstCallArgs.dnsServers).toEqual(['10.100.0.5']);
    expect(secondCallArgs.dnsServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for Phase 2 egress bypass label (unchanged)
// ---------------------------------------------------------------------------

describe('StackContainerManager — egress bypass label', () => {
  let mockPrisma: any;
  let manager: StackContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLongRunningContainer.mockResolvedValue({
      id: 'container-new',
      start: mockContainerStart,
    });
  });

  function buildManager(envResult: { egressFirewallEnabled: boolean; egressGatewayIp: string | null } | null) {
    mockPrisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue(envResult),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    return new StackContainerManager(mockDockerExecutor, mockPrisma);
  }

  it('sets mini-infra.egress.bypass=true label for bypass services', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: null });
    const bypassService = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('gw', bypassService, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBe('true');
  });

  it('does NOT set mini-infra.egress.bypass label for normal services', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: null });
    const normalService = makeService({ egressBypass: false });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('app', normalService, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBeUndefined();
  });

  it('does NOT set mini-infra.egress.bypass label when egressBypass is unset', async () => {
    manager = buildManager({ egressFirewallEnabled: false, egressGatewayIp: null });
    const service = makeService({});
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('app', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBeUndefined();
  });
});
