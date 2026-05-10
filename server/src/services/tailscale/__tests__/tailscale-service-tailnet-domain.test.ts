import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TailscaleService,
  extractTailnetSuffixFromDeviceName,
} from '../tailscale-service';

/**
 * `getTailnetDomain` underpins the URL composition in
 * `GET /api/stacks/:id/addon-endpoints`. It used to call only
 * `GET /tailnet/-/dns/searchpaths`, which returns the user-configured
 * MagicDNS search domains — empty on most tailnets, including default
 * Tailscale-issued `<id>.ts.net` ones — so the route always returned
 * `url: null` and the Connect panel rendered without a clickable link.
 *
 * The fix falls back to extracting the tailnet suffix from the first
 * managed device's `name` field, which is always
 * `<hostname>.<tailnet>.ts.net` for any tag:mini-infra-managed device.
 */
describe('extractTailnetSuffixFromDeviceName', () => {
  it('returns the suffix after the first dot', () => {
    expect(extractTailnetSuffixFromDeviceName('web-local.tail-abc.ts.net')).toBe(
      'tail-abc.ts.net',
    );
  });

  it('strips a trailing FQDN dot before splitting', () => {
    expect(extractTailnetSuffixFromDeviceName('web-local.tail-abc.ts.net.')).toBe(
      'tail-abc.ts.net',
    );
  });

  it('returns null for inputs without a dot', () => {
    expect(extractTailnetSuffixFromDeviceName('web-local')).toBeNull();
  });

  it('returns null for empty / nullish inputs', () => {
    expect(extractTailnetSuffixFromDeviceName('')).toBeNull();
    expect(extractTailnetSuffixFromDeviceName(null)).toBeNull();
    expect(extractTailnetSuffixFromDeviceName(undefined)).toBeNull();
  });
});

describe('TailscaleService.getTailnetDomain', () => {
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

  function searchpathsResponse(searchPaths: string[] | undefined): Response {
    return new Response(JSON.stringify(searchPaths ? { searchPaths } : {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function devicesResponse(
    devices: Array<{ name: string; hostname?: string }>,
  ): Response {
    return new Response(
      JSON.stringify({
        devices: devices.map((d) => ({
          nodeId: `n-${d.name}`,
          hostname: d.hostname ?? d.name.split('.')[0],
          name: d.name,
          lastSeen: new Date().toISOString(),
          tags: ['tag:mini-infra-managed'],
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('returns the searchpath value when one is configured', () => {
    return (async () => {
      fetchMock.mockResolvedValueOnce(searchpathsResponse(['custom.example.']));

      const result = await service.getTailnetDomain();

      expect(result).toBe('custom.example');
      // searchpaths was enough — device list should NOT be fetched.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    })();
  });

  it('falls back to the device-list when searchpaths is empty', async () => {
    fetchMock.mockResolvedValueOnce(searchpathsResponse(undefined));
    fetchMock.mockResolvedValueOnce(
      devicesResponse([{ name: 'web-local.tail5a560.ts.net' }]),
    );

    const result = await service.getTailnetDomain();

    expect(result).toBe('tail5a560.ts.net');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the device-list when searchpaths returns an empty array', async () => {
    fetchMock.mockResolvedValueOnce(searchpathsResponse([]));
    fetchMock.mockResolvedValueOnce(
      devicesResponse([{ name: 'api-local.tail5a560.ts.net' }]),
    );

    const result = await service.getTailnetDomain();

    expect(result).toBe('tail5a560.ts.net');
  });

  it('returns null when neither source has data (cold-start install)', async () => {
    fetchMock.mockResolvedValueOnce(searchpathsResponse(undefined));
    fetchMock.mockResolvedValueOnce(devicesResponse([]));

    const result = await service.getTailnetDomain();

    expect(result).toBeNull();
  });

  it('returns null without throwing when the device-list fallback errors', async () => {
    // The tailnet-domain lookup is a UI ergonomic, never load-bearing — a
    // failure here must not propagate and break the addon-endpoints route.
    fetchMock.mockResolvedValueOnce(searchpathsResponse(undefined));
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await service.getTailnetDomain();

    expect(result).toBeNull();
  });
});
