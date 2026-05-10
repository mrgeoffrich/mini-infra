import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the live TailscaleService so we don't reach for OAuth credentials or
// hit the Tailscale API. The shared mock is declared via `vi.hoisted` so it
// exists by the time the factory below runs (vi.mock factories are hoisted
// to the top of the module — referencing a plain `const` would crash with a
// temporal-dead-zone error).
const mockTailscaleService = vi.hoisted(() => ({
  getClientId: vi.fn<() => Promise<string | null>>(),
  getClientSecret: vi.fn<() => Promise<string | null>>(),
  listDevices: vi.fn(async () => []),
  getTailnetDomain: vi.fn(async () => null),
}));

vi.mock('../tailscale-service', () => ({
  // `new TailscaleService(prisma)` must construct an object, so the mock has
  // to be a real constructable class; an arrow factory triggers vitest's
  // "did not use 'function' or 'class'" warning and the mock instance comes
  // back without the stubbed methods. Returning `mockTailscaleService` from
  // the constructor body lets every test share the same vi.fn handles.
  TailscaleService: class {
    constructor() {
      return mockTailscaleService;
    }
  },
  TailscaleAuthError: class extends Error {},
}));

import { TailscaleDeviceStatusScheduler } from '../tailscale-device-status-scheduler';
import { ensureTailscaleDeviceStatusScheduler } from '../ensure-device-status-scheduler';

const fakePrisma = {} as never;

describe('ensureTailscaleDeviceStatusScheduler', () => {
  beforeEach(() => {
    // Reset both the mocks and the singleton between tests so each scenario
    // starts from a known empty state.
    vi.clearAllMocks();
    const existing = TailscaleDeviceStatusScheduler.getInstance();
    if (existing) {
      existing.stop();
      TailscaleDeviceStatusScheduler.setInstance(null);
    }
  });

  it('starts the scheduler when credentials are present and none is running', async () => {
    mockTailscaleService.getClientId.mockResolvedValue('client-id');
    mockTailscaleService.getClientSecret.mockResolvedValue('client-secret');

    expect(TailscaleDeviceStatusScheduler.getInstance()).toBeNull();

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);

    const scheduler = TailscaleDeviceStatusScheduler.getInstance();
    expect(scheduler).not.toBeNull();
    scheduler?.stop();
  });

  it('is idempotent when the scheduler is already running', async () => {
    mockTailscaleService.getClientId.mockResolvedValue('client-id');
    mockTailscaleService.getClientSecret.mockResolvedValue('client-secret');

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);
    const first = TailscaleDeviceStatusScheduler.getInstance();
    expect(first).not.toBeNull();

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);
    const second = TailscaleDeviceStatusScheduler.getInstance();

    expect(second).toBe(first);
    second?.stop();
  });

  it('stops a running scheduler when credentials are removed', async () => {
    mockTailscaleService.getClientId.mockResolvedValue('client-id');
    mockTailscaleService.getClientSecret.mockResolvedValue('client-secret');
    await ensureTailscaleDeviceStatusScheduler(fakePrisma);
    expect(TailscaleDeviceStatusScheduler.getInstance()).not.toBeNull();

    mockTailscaleService.getClientId.mockResolvedValue(null);
    mockTailscaleService.getClientSecret.mockResolvedValue(null);

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);

    expect(TailscaleDeviceStatusScheduler.getInstance()).toBeNull();
  });

  it('stays idle when credentials are absent and no scheduler is running', async () => {
    mockTailscaleService.getClientId.mockResolvedValue(null);
    mockTailscaleService.getClientSecret.mockResolvedValue(null);

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);

    expect(TailscaleDeviceStatusScheduler.getInstance()).toBeNull();
    expect(mockTailscaleService.listDevices).not.toHaveBeenCalled();
  });

  it('treats partial credentials (only client_id) as not configured', async () => {
    // Tailscale needs both for OAuth — leaving only the id behind would have
    // every poll log an auth error.
    mockTailscaleService.getClientId.mockResolvedValue('client-id');
    mockTailscaleService.getClientSecret.mockResolvedValue(null);

    await ensureTailscaleDeviceStatusScheduler(fakePrisma);

    expect(TailscaleDeviceStatusScheduler.getInstance()).toBeNull();
  });

  it('swallows credential-lookup failures', async () => {
    // Best-effort — a transient DB hiccup must not crash the route handler
    // that called us. The scheduler stays in whatever state it was in.
    mockTailscaleService.getClientId.mockRejectedValue(new Error('db unavailable'));

    await expect(
      ensureTailscaleDeviceStatusScheduler(fakePrisma),
    ).resolves.toBeUndefined();
  });
});
