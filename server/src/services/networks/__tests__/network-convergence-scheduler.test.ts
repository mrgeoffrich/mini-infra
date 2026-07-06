import { NetworkConvergenceScheduler } from '../network-convergence-scheduler';

let selfContainerId: string | null = null;
vi.mock('../../self-update', () => ({
  getOwnContainerId: () => selfContainerId,
}));

vi.mock('../network-converger', () => ({
  convergeStack: vi.fn().mockResolvedValue({ networksCreated: 0, membershipsConnected: 0, membershipsDisconnected: 0 }),
  convergeEnvironment: vi.fn().mockResolvedValue({ networksCreated: 0, membershipsConnected: 0, membershipsDisconnected: 0 }),
  convergeContainer: vi.fn().mockResolvedValue({ networksCreated: 0, membershipsConnected: 0, membershipsDisconnected: 0 }),
  convergeAll: vi.fn().mockResolvedValue({ networksCreated: 0, membershipsConnected: 0, membershipsDisconnected: 0 }),
}));

import { convergeStack, convergeEnvironment, convergeContainer, convergeAll } from '../network-converger';

function makeDeps() {
  return {
    createNetworkManager: vi.fn().mockResolvedValue({} as any),
    createDockerExecutor: vi.fn().mockResolvedValue({ getDockerClient: () => ({}) } as any),
  };
}

function makePrisma(findUniqueImpl?: (args: any) => any) {
  return {
    managedNetwork: {
      findUnique: vi.fn(async (args: any) => (findUniqueImpl ? findUniqueImpl(args) : null)),
    },
  } as any;
}

describe('NetworkConvergenceScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    selfContainerId = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debouncing', () => {
    it('coalesces repeated stack triggers within the debounce window into a single converge call', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 5000 });

      scheduler.scheduleStackConverge('stack-1');
      vi.advanceTimersByTime(2000);
      scheduler.scheduleStackConverge('stack-1'); // resets the timer
      vi.advanceTimersByTime(2000);
      scheduler.scheduleStackConverge('stack-1'); // resets again
      vi.advanceTimersByTime(4999);
      expect(convergeStack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(convergeStack).toHaveBeenCalledTimes(1);
      expect(convergeStack).toHaveBeenCalledWith('stack-1', expect.any(Object));
    });

    it('tracks independent debounce timers per stack id', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 1000 });

      scheduler.scheduleStackConverge('stack-1');
      scheduler.scheduleStackConverge('stack-2');
      await vi.advanceTimersByTimeAsync(1001);

      expect(convergeStack).toHaveBeenCalledTimes(2);
      expect(convergeStack).toHaveBeenCalledWith('stack-1', expect.any(Object));
      expect(convergeStack).toHaveBeenCalledWith('stack-2', expect.any(Object));
    });

    it('cancels all pending debounce timers on stop()', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 1000 });

      scheduler.scheduleStackConverge('stack-1');
      scheduler.scheduleEnvironmentConverge('env-1');
      scheduler.scheduleContainerConverge('c-1');
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(2000);

      expect(convergeStack).not.toHaveBeenCalled();
      expect(convergeEnvironment).not.toHaveBeenCalled();
      expect(convergeContainer).not.toHaveBeenCalled();
    });
  });

  describe('handleContainerEvent', () => {
    it('schedules a container converge for a "start" action on a container carrying mini-infra\'s own stack-id label', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 100 });

      scheduler.handleContainerEvent({ action: 'start', containerId: 'c-1', containerName: 'c-1', labels: { 'mini-infra.stack-id': 'stack-1' }, time: 0 });
      await vi.advanceTimersByTimeAsync(101);

      expect(convergeContainer).toHaveBeenCalledWith('c-1', expect.any(Object));
    });

    it('ignores non-"start" actions entirely', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 100 });

      scheduler.handleContainerEvent({ action: 'die', containerId: 'c-1', containerName: 'c-1', labels: { 'mini-infra.stack-id': 'stack-1' }, time: 0 });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeContainer).not.toHaveBeenCalled();
    });

    it('ignores a foreign container with no mini-infra labels and that is not the self container (shared-daemon safety)', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 100 });

      scheduler.handleContainerEvent({ action: 'start', containerId: 'foreign-1', containerName: 'unrelated', labels: {}, time: 0 });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeContainer).not.toHaveBeenCalled();
    });

    it('still schedules a converge for the self container even without mini-infra labels', async () => {
      selfContainerId = 'self-id';
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { debounceMs: 100 });

      scheduler.handleContainerEvent({ action: 'start', containerId: 'self-id', containerName: 'mini-infra', labels: {}, time: 0 });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeContainer).toHaveBeenCalledWith('self-id', expect.any(Object));
    });
  });

  describe('handleNetworkEvent', () => {
    it('scopes to the owning stack when the network name resolves to a stack-owned ManagedNetwork row', async () => {
      const prisma = makePrisma(() => ({ scope: 'stack', stackId: 'stack-1', environmentId: null }));
      const scheduler = new NetworkConvergenceScheduler(prisma, makeDeps(), { debounceMs: 100 });

      scheduler.handleNetworkEvent({ action: 'disconnect', networkId: 'nid', networkName: 'proj_default' });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeStack).toHaveBeenCalledWith('stack-1', expect.any(Object));
      expect(convergeEnvironment).not.toHaveBeenCalled();
      expect(convergeAll).not.toHaveBeenCalled();
    });

    it('scopes to the owning environment when the network name resolves to an environment-owned row', async () => {
      const prisma = makePrisma(() => ({ scope: 'environment', stackId: null, environmentId: 'env-1' }));
      const scheduler = new NetworkConvergenceScheduler(prisma, makeDeps(), { debounceMs: 100 });

      scheduler.handleNetworkEvent({ action: 'disconnect', networkId: 'nid', networkName: 'env-1-egress' });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeEnvironment).toHaveBeenCalledWith('env-1', expect.any(Object));
      expect(convergeStack).not.toHaveBeenCalled();
    });

    it('falls back to a full sweep for a host-scoped network row', async () => {
      const prisma = makePrisma(() => ({ scope: 'host', stackId: null, environmentId: null }));
      const scheduler = new NetworkConvergenceScheduler(prisma, makeDeps(), { debounceMs: 100 });

      scheduler.handleNetworkEvent({ action: 'disconnect', networkId: 'nid', networkName: 'mini-infra-vault' });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeAll).toHaveBeenCalled();
    });

    it('never converges anything for an unrecognised network (no ManagedNetwork row) — the shared-Docker-host safety rule', async () => {
      const prisma = makePrisma(() => null);
      const scheduler = new NetworkConvergenceScheduler(prisma, makeDeps(), { debounceMs: 100 });

      scheduler.handleNetworkEvent({ action: 'create', networkId: 'nid', networkName: 'some-other-projects-network' });
      await vi.advanceTimersByTimeAsync(200);

      expect(convergeStack).not.toHaveBeenCalled();
      expect(convergeEnvironment).not.toHaveBeenCalled();
      expect(convergeAll).not.toHaveBeenCalled();
    });

    it('ignores a network event with no network name at all', () => {
      const prisma = makePrisma();
      const scheduler = new NetworkConvergenceScheduler(prisma, makeDeps(), { debounceMs: 100 });

      scheduler.handleNetworkEvent({ action: 'destroy', networkId: 'nid' });

      expect(prisma.managedNetwork.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('periodic sweep', () => {
    it('tick() runs a full convergeAll sweep', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps());
      await scheduler.tick();
      expect(convergeAll).toHaveBeenCalledTimes(1);
    });

    it('start() schedules recurring ticks at the configured interval without an immediate synchronous tick (unlike the GC scheduler, this is meant to run quietly in the background)', async () => {
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), makeDeps(), { intervalMs: 60_000 });
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(convergeAll).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(convergeAll).toHaveBeenCalledTimes(2);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('tick() tolerates Docker being unreachable (createNetworkManager rejects) without throwing', async () => {
      const deps = {
        createNetworkManager: vi.fn().mockRejectedValue(new Error('docker down')),
        createDockerExecutor: vi.fn().mockResolvedValue({ getDockerClient: () => ({}) } as any),
      };
      const scheduler = new NetworkConvergenceScheduler(makePrisma(), deps);
      const result = await scheduler.tick();
      expect(result).toBeUndefined();
      expect(convergeAll).not.toHaveBeenCalled();
    });
  });
});
