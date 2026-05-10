import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TailscaleService } from '../tailscale-service';

/**
 * `listDevices` dedupes by hostname because Tailscale's tailnet treats DNS
 * names as unique but lets two devices share an OS hostname (the redeploy
 * collision: ephemeral GC lags, the new node gets `<host>-1.<tailnet>.ts.net`
 * but keeps `hostname: <host>`). Downstream consumers join by hostname; if we
 * surface both rows the JS Map collapse keeps whichever arrived last and the
 * Connect panel can show the stale offline copy instead of the live device.
 */
describe('TailscaleService.listDevices — hostname dedupe', () => {
  let service: TailscaleService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    const fakePrisma = {
      // The `getAccessToken` and `getAllManagedTags` paths read the DB; stub
      // them via a partial prisma so we don't need a live DB for the test.
      tailscaleSettings: {
        findUnique: vi.fn(async () => ({
          accessToken: 'token',
          accessTokenExpiresAt: new Date(Date.now() + 60_000),
          extraTags: [],
        })),
      },
    } as never;
    service = new TailscaleService(fakePrisma, fetchMock as unknown as typeof fetch);
    // Spy past auth lookups so the test focuses on the mapping logic.
    vi.spyOn(service, 'getAccessToken').mockResolvedValue('token');
    vi.spyOn(service, 'getAllManagedTags').mockResolvedValue([
      'tag:mini-infra-managed',
    ]);
  });

  function deviceJson(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      nodeId: `node-${Math.random()}`,
      hostname: 'web-local',
      name: 'web-local.tail-abc.ts.net',
      lastSeen: new Date().toISOString(),
      tags: ['tag:mini-infra-managed'],
      ...overrides,
    };
  }

  function respondWith(devices: Record<string, unknown>[]) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('returns the online device when the same hostname has both online and offline entries', async () => {
    const now = Date.now();
    respondWith([
      deviceJson({
        nodeId: 'stale',
        name: 'web-local.tail-abc.ts.net',
        // 25 minutes ago — beyond the 5-minute online threshold.
        lastSeen: new Date(now - 25 * 60 * 1000).toISOString(),
      }),
      deviceJson({
        nodeId: 'fresh',
        name: 'web-local-1.tail-abc.ts.net',
        // 30 seconds ago — well within the online threshold.
        lastSeen: new Date(now - 30 * 1000).toISOString(),
      }),
    ]);

    const devices = await service.listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe('fresh');
    expect(devices[0]?.online).toBe(true);
  });

  it('falls back to the most recent lastSeen when both entries for a hostname are offline', async () => {
    const now = Date.now();
    respondWith([
      deviceJson({
        nodeId: 'older',
        name: 'web-local.tail-abc.ts.net',
        lastSeen: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
      }),
      deviceJson({
        nodeId: 'newer',
        name: 'web-local-1.tail-abc.ts.net',
        lastSeen: new Date(now - 10 * 60 * 1000).toISOString(), // 10m ago
      }),
    ]);

    const devices = await service.listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe('newer');
  });

  it('keeps distinct hostnames separate', async () => {
    respondWith([
      deviceJson({ nodeId: 'a', hostname: 'web-local' }),
      deviceJson({ nodeId: 'b', hostname: 'api-local' }),
    ]);

    const devices = await service.listDevices();

    expect(devices.map((d) => d.hostname).sort()).toEqual(['api-local', 'web-local']);
  });

  it('still returns a single online device for a hostname with no duplicates', async () => {
    respondWith([deviceJson({ nodeId: 'solo', hostname: 'web-local' })]);

    const devices = await service.listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]?.online).toBe(true);
  });

  it('drops devices that lack the managed tag entirely (not deduped — filtered)', async () => {
    respondWith([
      deviceJson({ nodeId: 'tagged', tags: ['tag:mini-infra-managed'] }),
      deviceJson({ nodeId: 'untagged', tags: ['tag:other'] }),
    ]);

    const devices = await service.listDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe('tagged');
  });
});
