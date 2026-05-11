import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Docker from 'dockerode';
import { LongRunningContainerManager } from '../long-running-container';
import ContainerLabelManager from '../../container/container-label-manager';

// The logger factory is mocked globally by setup-unit.ts.

// We assert by inspecting the dockerode createContainer payload — same
// pattern as long-running-container-dns.test.ts.
const mockCreateContainer = vi.fn();
const mockDocker = {
  createContainer: mockCreateContainer,
} as unknown as Docker;

const mockGenerateTaskExecutionLabels = vi.fn().mockReturnValue({});
const mockLabelManager = {
  generateTaskExecutionLabels: mockGenerateTaskExecutionLabels,
} as unknown as ContainerLabelManager;

describe('LongRunningContainerManager — devices', () => {
  let manager: LongRunningContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LongRunningContainerManager(mockDocker, mockLabelManager);
    mockCreateContainer.mockResolvedValue({ id: 'container-xyz', start: vi.fn() });
  });

  it('does NOT set HostConfig.Devices when devices is omitted', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Devices).toBeUndefined();
  });

  it('does NOT set HostConfig.Devices when devices is an empty array', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      devices: [],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Devices).toBeUndefined();
  });

  it('translates a bare device path to the dockerode HostConfig.Devices shape', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      devices: ['/dev/net/tun'],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Devices).toEqual([
      {
        PathOnHost: '/dev/net/tun',
        PathInContainer: '/dev/net/tun',
        CgroupPermissions: 'rwm',
      },
    ]);
  });

  it('translates mixed bare / HOST:CONTAINER / HOST:CONTAINER:PERMS specs', async () => {
    await manager.createLongRunningContainer({
      image: 'myapp:latest',
      projectName: 'myproject',
      serviceName: 'myservice',
      env: {},
      devices: [
        '/dev/net/tun',
        '/dev/host-side:/dev/in-container',
        '/dev/h:/dev/c:rw',
      ],
    });

    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Devices).toEqual([
      { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
      { PathOnHost: '/dev/host-side', PathInContainer: '/dev/in-container', CgroupPermissions: 'rwm' },
      { PathOnHost: '/dev/h', PathInContainer: '/dev/c', CgroupPermissions: 'rw' },
    ]);
  });

  it('propagates parse failures from parseDeviceSpec', async () => {
    await expect(
      manager.createLongRunningContainer({
        image: 'myapp:latest',
        projectName: 'myproject',
        serviceName: 'myservice',
        env: {},
        devices: ['/dev/host::rw'],
      }),
    ).rejects.toThrow(/empty segments/);
  });
});
