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

const mockLogWarn = vi.fn();

// We rely on the globally mocked logger from setup-unit.ts. The child() call
// returns the same mock object, so warn calls are captured via the module-level
// mock. We just need to verify `createLongRunningContainer` call args.

// ---------------------------------------------------------------------------
// Tests for resolveEgressDnsServers (tested via createAndStartContainer)
// ---------------------------------------------------------------------------

describe('StackContainerManager — egress DNS injection', () => {
  let mockPrisma: any;
  let manager: StackContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLongRunningContainer.mockResolvedValue({
      id: 'container-new',
      start: mockContainerStart,
    });
  });

  // Helper: build manager with a specific environment findUnique result
  function buildManager(envResult: { egressGatewayIp: string | null } | null) {
    mockPrisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue(envResult),
      },
    };
    return new StackContainerManager(mockDockerExecutor, mockPrisma);
  }

  // --- Test 1: host-level stack (no environmentId) → no DNS injection ---

  it('injects no DNS for a host-level stack (no environmentId)', async () => {
    manager = buildManager(null);
    const service = makeService();
    const options = makeOptions(null);

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    // Prisma must not be called for host-level stacks
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('injects no DNS when environmentId is undefined', async () => {
    manager = buildManager(null);
    const service = makeService();
    const options = makeOptions(undefined);

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  // --- Test 2: egressBypass: true → no DNS injection ---

  it('injects no DNS when egressBypass is true (egress-gateway service itself)', async () => {
    manager = buildManager({ egressGatewayIp: '10.100.0.2' });
    const service = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('egress-gw', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
    // Prisma must not be called (bypass short-circuits before DB lookup)
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  // --- Test 3: env with egressGatewayIp, no bypass → DNS injected ---

  it('injects DNS servers when env has egressGatewayIp and no bypass', async () => {
    manager = buildManager({ egressGatewayIp: '10.100.0.2' });
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toEqual(['10.100.0.2']);
    expect(mockPrisma.environment.findUnique).toHaveBeenCalledWith({
      where: { id: 'env-1' },
      select: { egressGatewayIp: true },
    });
  });

  // --- Test 4: env with no egressGatewayIp, no bypass → no DNS, warning logged ---

  it('injects no DNS and does not throw when egressGatewayIp is null', async () => {
    manager = buildManager({ egressGatewayIp: null });
    const service = makeService();
    const options = makeOptions('env-1');

    // Must not throw — we don't want to break stack apply for envs without a gateway
    await expect(manager.createAndStartContainer('web', service, options)).resolves.toBeDefined();

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
  });

  it('injects no DNS and does not throw when environment row is not found', async () => {
    manager = buildManager(null);
    // Env has an ID but findUnique returns null (e.g. race during env creation)
    const service = makeService();
    const options = makeOptions('env-missing');

    await expect(manager.createAndStartContainer('web', service, options)).resolves.toBeDefined();

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.dnsServers).toBeUndefined();
  });

  // --- Test 5: multiple services in same stack, mixed bypass ---

  it('injects DNS only for non-bypass services in the same stack', async () => {
    manager = buildManager({ egressGatewayIp: '10.100.0.5' });
    const options = makeOptions('env-1');

    const normalService = makeService({ egressBypass: false });
    const bypassService = makeService({ egressBypass: true });

    // First call: normal service
    await manager.createAndStartContainer('app', normalService, options);
    // Second call: bypass service (the egress gateway itself)
    await manager.createAndStartContainer('gw', bypassService, options);

    const firstCallArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    const secondCallArgs = mockCreateLongRunningContainer.mock.calls[1][0];

    expect(firstCallArgs.dnsServers).toEqual(['10.100.0.5']);
    expect(secondCallArgs.dnsServers).toBeUndefined();
  });
});
