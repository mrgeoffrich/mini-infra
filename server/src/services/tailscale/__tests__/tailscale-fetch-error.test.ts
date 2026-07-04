import { describe, it, expect } from 'vitest';
import { describeFetchError } from '../tailscale-service';

/**
 * `describeFetchError` unwraps the `error.cause` that Node's global `fetch`
 * hides behind a bare "fetch failed". This is what turned an undiagnosable
 * Tailscale connectivity failure into an actionable one — the field bug was a
 * no-IPv6 host where every AAAA address was `ENETUNREACH`, which `fetch`
 * reported only as "fetch failed" until the cause was surfaced.
 */
describe('describeFetchError', () => {
  it('appends the cause code + message for a single-address failure', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = Object.assign(
      new Error('connect ECONNREFUSED 192.200.0.101:443'),
      { code: 'ECONNREFUSED' },
    );

    const out = describeFetchError(err);
    expect(out).toContain('fetch failed');
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('192.200.0.101:443');
  });

  it('flattens per-address errors from a Happy Eyeballs AggregateError cause', () => {
    const err = new TypeError('fetch failed');
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('connect ENETUNREACH'), {
          code: 'ENETUNREACH',
          address: '2606:b740:49::105',
        }),
        Object.assign(new Error('connect ETIMEDOUT'), {
          code: 'ETIMEDOUT',
          address: '192.200.0.101',
        }),
      ],
      'All connection attempts failed',
    );
    (err as { cause?: unknown }).cause = aggregate;

    const out = describeFetchError(err);
    expect(out).toContain('2606:b740:49::105 ENETUNREACH');
    expect(out).toContain('192.200.0.101 ETIMEDOUT');
  });

  it('handles an Error with no cause', () => {
    expect(describeFetchError(new Error('boom'))).toBe('boom');
  });

  it('handles a non-Error input', () => {
    expect(describeFetchError('nope')).toBe('nope');
    expect(describeFetchError(42)).toBe('42');
  });

  it('handles a non-Error cause', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = 'raw string cause';
    expect(describeFetchError(err)).toContain('raw string cause');
  });
});
