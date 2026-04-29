/**
 * Tests for EgressGatewayClient
 */

import { EgressGatewayClient, EgressGatewayError } from '../egress-gateway-client';

// Mock the logger to avoid needing real config
vi.mock('../../../lib/logger-factory', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const GATEWAY_IP = '172.30.0.2';
const ADMIN_PORT = 8054;

function makeClient(timeoutMs = 5000): EgressGatewayClient {
  return new EgressGatewayClient(GATEWAY_IP, ADMIN_PORT, timeoutMs);
}

describe('EgressGatewayClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---------------------------------------------------------------------------
  // pushContainerMap — happy path
  // ---------------------------------------------------------------------------

  describe('pushContainerMap', () => {
    it('sends POST /admin/container-map and returns parsed response', async () => {
      const mockResponse = { version: 1, accepted: true, entryCount: 3 };
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockResponse),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.pushContainerMap({
        version: 1,
        entries: [
          { ip: '172.30.0.5', stackId: 'stk_abc', serviceName: 'web', containerId: 'c1' },
          { ip: '172.30.0.6', stackId: 'stk_abc', serviceName: 'worker', containerId: 'c2' },
          { ip: '172.30.0.7', stackId: 'stk_xyz', serviceName: 'api', containerId: 'c3' },
        ],
      });

      expect(result).toEqual({ version: 1, entryCount: 3 });

      const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe(`http://${GATEWAY_IP}:${ADMIN_PORT}/admin/container-map`);
      expect(calledOpts.method).toBe('POST');
      expect(calledOpts.headers).toMatchObject({ 'Content-Type': 'application/json' });
      const sentBody = JSON.parse(calledOpts.body as string);
      expect(sentBody.version).toBe(1);
      expect(sentBody.entries).toHaveLength(3);
    });

    it('throws EgressGatewayError on non-2xx with JSON error body', async () => {
      const errorBody = { error: 'bad version', detail: 'version mismatch' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValueOnce(errorBody),
      }));

      const client = makeClient();
      await expect(
        client.pushContainerMap({ version: 1, entries: [] }),
      ).rejects.toThrow(EgressGatewayError);

      try {
        await client.pushContainerMap({ version: 1, entries: [] });
      } catch (err) {
        if (err instanceof EgressGatewayError) {
          expect(err.status).toBe(400);
        }
      }
    });

    it('throws EgressGatewayError on non-2xx with non-JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: vi.fn().mockRejectedValueOnce(new Error('not JSON')),
        text: vi.fn().mockResolvedValueOnce('Service Unavailable'),
      }));

      const client = makeClient();
      await expect(
        client.pushContainerMap({ version: 1, entries: [] }),
      ).rejects.toThrow(EgressGatewayError);
    });
  });

  // ---------------------------------------------------------------------------
  // health — happy path
  // ---------------------------------------------------------------------------

  describe('health', () => {
    it('sends GET /admin/health and returns parsed response', async () => {
      const healthResponse = {
        ok: true,
        rulesVersion: 3,
        uptimeSeconds: 120,
        listeners: { proxy: true, admin: true },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(healthResponse),
      }));

      const client = makeClient();
      const result = await client.health();

      expect(result.rulesVersion).toBe(3);
      expect(result.uptimeSeconds).toBe(120);
      expect(result.listeners.proxy).toBe(true);
      expect(result.listeners.admin).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout handling
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('throws EgressGatewayError when fetch is aborted', async () => {
      // Simulate AbortError
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abortError));

      const client = makeClient(100);
      const err = await client.pushContainerMap({ version: 1, entries: [] }).catch((e) => e);

      expect(err).toBeInstanceOf(EgressGatewayError);
      expect((err as EgressGatewayError).message).toContain('timed out');
      expect((err as EgressGatewayError).status).toBe(0);
    });

    it('throws EgressGatewayError on network error (not abort)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));

      const client = makeClient();
      const err = await client.pushContainerMap({ version: 1, entries: [] }).catch((e) => e);

      expect(err).toBeInstanceOf(EgressGatewayError);
      expect((err as EgressGatewayError).message).toContain('ECONNREFUSED');
      expect((err as EgressGatewayError).status).toBe(0);
    });
  });
});
