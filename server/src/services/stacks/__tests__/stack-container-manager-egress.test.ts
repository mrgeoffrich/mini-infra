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

const mockGetDockerClient = vi.fn(() => ({
  getContainer: vi.fn(() => ({ start: mockContainerStart })),
}));

const mockDockerExecutor = {
  createLongRunningContainer: mockCreateLongRunningContainer,
  getDockerClient: mockGetDockerClient,
  pullImageWithAutoAuth: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// HTTP_PROXY env injection — fires when env has a provisioned egress gateway
// AND an `egress` InfraResource exists for that env. The helper that decides
// is exercised in egress-injection.test.ts; here we verify the StackContainer-
// Manager wires it through to createLongRunningContainer correctly.
// ---------------------------------------------------------------------------

describe('StackContainerManager — egress env injection', () => {
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
    envResult: { egressGatewayIp: string | null } | null,
    egressResource: { name: string; metadata: unknown } | null = null,
  ) {
    mockPrisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue(envResult),
      },
      infraResource: {
        findFirst: vi.fn().mockResolvedValue(egressResource),
      },
    };
    return new StackContainerManager(mockDockerExecutor, mockPrisma);
  }

  it('injects HTTP_PROXY env vars when egress gateway and egress InfraResource exist', async () => {
    manager = buildManager(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.16.0/24' } },
    );
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['HTTPS_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['http_proxy']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['https_proxy']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['NO_PROXY']).toContain('localhost');
    expect(callArgs.env['NO_PROXY']).toContain('127.0.0.0/8');
    expect(callArgs.env['NO_PROXY']).toContain('172.30.16.0/24');
    expect(callArgs.env['no_proxy']).toBe(callArgs.env['NO_PROXY']);
    // No legacy DNS injection — Docker's default resolver remains.
    expect(callArgs.dnsServers).toBeUndefined();
  });

  it('omits the bridge CIDR from NO_PROXY when egress InfraResource has no subnet metadata', async () => {
    manager = buildManager(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: null },
    );
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBe('http://egress-gateway:3128');
    expect(callArgs.env['NO_PROXY']).toBe('localhost,127.0.0.1,::1,127.0.0.0/8');
  });

  it('skips injection when service has egressBypass=true (gateway service itself)', async () => {
    manager = buildManager({ egressGatewayIp: '172.30.16.3' });
    const service = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('egress-gw', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
    expect(callArgs.env['HTTPS_PROXY']).toBeUndefined();
    // Bypass short-circuits before any DB lookup.
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('skips injection for host-level stacks (no environmentId)', async () => {
    manager = buildManager(null);
    const service = makeService();
    const options = makeOptions(null);

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
    expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
  });

  it('skips injection when env has no egressGatewayIp (gateway not provisioned)', async () => {
    manager = buildManager({ egressGatewayIp: null });
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
  });

  it('skips injection when egress InfraResource is missing (gateway provisioning incomplete)', async () => {
    manager = buildManager(
      { egressGatewayIp: '172.30.16.3' },
      null,
    );
    const service = makeService();
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBeUndefined();
  });

  it('lets static service env override injected proxy env', async () => {
    manager = buildManager(
      { egressGatewayIp: '172.30.16.3' },
      { name: 'env1-egress', metadata: { subnet: '172.30.1.0/24' } },
    );
    const service = makeService({ env: { HTTP_PROXY: 'http://custom-proxy:9090', APP_VAR: 'hello' } });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('web', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.env['HTTP_PROXY']).toBe('http://custom-proxy:9090');
    expect(callArgs.env['APP_VAR']).toBe('hello');
    // Other proxy vars are still injected.
    expect(callArgs.env['HTTPS_PROXY']).toBe('http://egress-gateway:3128');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 egress bypass label (unchanged contract, retained here for sanity).
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

  function buildManager(envResult: { egressGatewayIp: string | null } | null) {
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
    manager = buildManager({ egressGatewayIp: null });
    const bypassService = makeService({ egressBypass: true });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('gw', bypassService, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBe('true');
  });

  it('does not set the egress.bypass label for non-bypass services', async () => {
    manager = buildManager({ egressGatewayIp: null });
    const service = makeService({ egressBypass: false });
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('app', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBeUndefined();
  });

  it('does not set the egress.bypass label when egressBypass is unset', async () => {
    manager = buildManager({ egressGatewayIp: null });
    const service = makeService({});
    const options = makeOptions('env-1');

    await manager.createAndStartContainer('app', service, options);

    const callArgs = mockCreateLongRunningContainer.mock.calls[0][0];
    expect(callArgs.labels?.['mini-infra.egress.bypass']).toBeUndefined();
  });
});
