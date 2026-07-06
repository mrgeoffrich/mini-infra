import { describe, it, expect } from 'vitest';
import dns from 'node:dns';
import net from 'node:net';
import { configureOutboundNetworking } from '../lib/net-runtime';

/**
 * The load-bearing fix is raising the Happy Eyeballs attempt timeout above
 * Node's aggressive 250ms default — that default abandons healthy cross-region
 * connects (e.g. ~280ms to api.tailscale.com) and makes `fetch` fail where curl
 * succeeds. IPv4-first + explicit Happy Eyeballs are hardening on top.
 */
describe('configureOutboundNetworking', () => {
  it('raises the family attempt timeout well above the 250ms default', () => {
    const state = configureOutboundNetworking();

    expect(state.autoSelectFamilyAttemptTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(
      state.autoSelectFamilyAttemptTimeoutMs,
    );
  });

  it('sets ipv4first result order and keeps autoSelectFamily on', () => {
    const state = configureOutboundNetworking();

    expect(state.dnsResultOrder).toBe('ipv4first');
    expect(state.autoSelectFamily).toBe(true);
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
  });

  it('is idempotent', () => {
    const first = configureOutboundNetworking();
    const second = configureOutboundNetworking();
    expect(second).toEqual(first);
  });
});
