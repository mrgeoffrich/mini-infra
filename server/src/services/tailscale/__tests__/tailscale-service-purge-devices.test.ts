import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TailscaleService } from '../tailscale-service';

/**
 * `purgeStaleManagedDevicesByHostname` is the redeploy-cleanup hook the
 * Tailscale addon-provision path calls before minting a fresh authkey. It
 * frees the OS-hostname slot squatted by stale ephemeral registrations so
 * the new sidecar can register under the unsuffixed DNS name.
 *
 * Hard rule the tests pin: never delete an online device. The provision
 * call runs on every apply (the authkey is regenerated even when the
 * sidecar isn't recreated), so deleting a live device would kick our own
 * sidecar off the tailnet.
 */
describe('TailscaleService.purgeStaleManagedDevicesByHostname', () => {
  let service: TailscaleService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    const fakePrisma = {} as never;
    service = new TailscaleService(fakePrisma, fetchMock as unknown as typeof fetch);
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

  function listResponse(devices: Record<string, unknown>[]): Response {
    return new Response(JSON.stringify({ devices }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function deleteResponse(status: number): Response {
    // Node's `Response` rejects bodies on 1xx/204/205/304. Use `null` for
    // success codes to keep the constructor happy.
    return new Response(status >= 200 && status < 300 ? null : 'error', {
      status,
    });
  }

  it('deletes only offline matching-hostname devices and leaves the live device alone', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      listResponse([
        deviceJson({
          nodeId: 'live',
          name: 'web-local-1.tail-abc.ts.net',
          lastSeen: new Date(now - 30 * 1000).toISOString(),
        }),
        deviceJson({
          nodeId: 'stale',
          name: 'web-local.tail-abc.ts.net',
          lastSeen: new Date(now - 30 * 60 * 1000).toISOString(),
        }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(deleteResponse(204));

    const result = await service.purgeStaleManagedDevicesByHostname('web-local');

    expect(result).toEqual({ deleted: 1, errors: 0 });

    // Two fetch calls in total: the list + the single delete (NOT a delete
    // for the live device).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deleteCall = fetchMock.mock.calls[1];
    expect(deleteCall[0]).toContain('/device/stale');
    expect(deleteCall[1]?.method).toBe('DELETE');
  });

  it('treats a 404 from the upstream delete as success (Tailscale GC won the race)', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      listResponse([
        deviceJson({
          nodeId: 'gone',
          lastSeen: new Date(now - 30 * 60 * 1000).toISOString(),
        }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(deleteResponse(404));

    const result = await service.purgeStaleManagedDevicesByHostname('web-local');

    expect(result).toEqual({ deleted: 1, errors: 0 });
  });

  it('does nothing when no stale devices match the hostname', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      listResponse([
        deviceJson({
          nodeId: 'live',
          lastSeen: new Date(now - 30 * 1000).toISOString(),
        }),
        deviceJson({
          nodeId: 'other-host-stale',
          hostname: 'api-local',
          lastSeen: new Date(now - 30 * 60 * 1000).toISOString(),
        }),
      ]),
    );

    const result = await service.purgeStaleManagedDevicesByHostname('web-local');

    expect(result).toEqual({ deleted: 0, errors: 0 });
    // Only the list call; no DELETE issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts errors per failed delete but keeps going for the rest', async () => {
    const now = Date.now();
    const stale = (id: string) =>
      deviceJson({
        nodeId: id,
        lastSeen: new Date(now - 30 * 60 * 1000).toISOString(),
      });
    fetchMock.mockResolvedValueOnce(listResponse([stale('a'), stale('b'), stale('c')]));
    fetchMock.mockResolvedValueOnce(deleteResponse(500));
    fetchMock.mockResolvedValueOnce(deleteResponse(204));
    fetchMock.mockResolvedValueOnce(deleteResponse(204));

    const result = await service.purgeStaleManagedDevicesByHostname('web-local');

    expect(result).toEqual({ deleted: 2, errors: 1 });
  });

  it('never throws when listing fails — provisioning must continue', async () => {
    fetchMock.mockRejectedValueOnce(new Error('upstream down'));

    const result = await service.purgeStaleManagedDevicesByHostname('web-local');

    expect(result).toEqual({ deleted: 0, errors: 1 });
  });
});

describe('TailscaleService.deleteDevice', () => {
  let service: TailscaleService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    const fakePrisma = {} as never;
    service = new TailscaleService(fakePrisma, fetchMock as unknown as typeof fetch);
    vi.spyOn(service, 'getAccessToken').mockResolvedValue('token');
  });

  it('hits DELETE /api/v2/device/:id with the bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await service.deleteDevice('node-xyz');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tailscale.com/api/v2/device/node-xyz');
    expect(init?.method).toBe('DELETE');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('treats 404 as already-gone (no throw)', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(service.deleteDevice('gone')).resolves.toBeUndefined();
  });

  it('throws on non-2xx, non-404 responses so the caller can decide what to do', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(service.deleteDevice('node')).rejects.toThrow(/500/);
  });

  it('rejects an empty deviceId at the boundary', async () => {
    await expect(service.deleteDevice('')).rejects.toThrow();
  });
});
