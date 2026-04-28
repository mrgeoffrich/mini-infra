import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LongRunningContainerManager } from '../long-running-container';
import ContainerLabelManager from '../../container/container-label-manager';

// The logger factory is mocked globally by setup-unit.ts.

const mockCreateContainer = vi.fn();
const mockDocker = {
  createContainer: mockCreateContainer,
} as any;

const mockGenerateTaskExecutionLabels = vi.fn().mockReturnValue({});
const mockLabelManager = {
  generateTaskExecutionLabels: mockGenerateTaskExecutionLabels,
} as unknown as ContainerLabelManager;

describe('LongRunningContainerManager — dnsServers', () => {
  let manager: LongRunningContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LongRunningContainerManager(mockDocker, mockLabelManager);
    mockCreateContainer.mockResolvedValue({ id: 'container-abc', start: vi.fn() });
  });

  it('does NOT set HostConfig.Dns when dnsServers is not provided', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Dns).toBeUndefined();
  });

  it('does NOT set HostConfig.Dns when dnsServers is an empty array', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      dnsServers: [],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Dns).toBeUndefined();
  });

  it('sets HostConfig.Dns when dnsServers is provided', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      dnsServers: ['10.100.0.2'],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Dns).toEqual(['10.100.0.2']);
  });

  it('supports multiple DNS servers', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      dnsServers: ['10.100.0.2', '8.8.8.8'],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Dns).toEqual(['10.100.0.2', '8.8.8.8']);
  });
});
