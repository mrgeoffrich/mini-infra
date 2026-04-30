/**
 * Unit tests for `summariseServiceFailures` — the helper that builds
 * `Stack.lastFailureReason` from per-service apply results.
 *
 * Customer feedback #5: this field used to stay null when service apply
 * failed (port conflict, image pull error, healthcheck timeout, container
 * crash on startup). Operators had to use `docker ps` + `docker logs` to
 * find the real reason. The helper is pure so it's worth nailing down its
 * formatting + truncation contract.
 */

import { describe, it, expect } from 'vitest';
import type { ServiceApplyResult } from '@mini-infra/types';

import { summariseServiceFailures } from '../services/stacks/stack-failure-summary';

function ok(serviceName: string): ServiceApplyResult {
  return { serviceName, action: 'create', success: true, duration: 100 };
}

function fail(serviceName: string, error: string): ServiceApplyResult {
  return { serviceName, action: 'create', success: false, duration: 100, error };
}

describe('summariseServiceFailures', () => {
  it('joins each failed service into a single line with serviceName: error', () => {
    const r = summariseServiceFailures([
      ok('web'),
      fail('worker', 'Container exited with code 1'),
    ]);
    expect(r).toBe('worker: Container exited with code 1');
  });

  it('joins multiple failures with " | " so they read on a single line', () => {
    const r = summariseServiceFailures([
      fail('a', 'Image pull failed'),
      fail('b', 'Port 8080 already in use'),
    ]);
    expect(r).toBe('a: Image pull failed | b: Port 8080 already in use');
  });

  it('collapses internal whitespace so multiline error blobs stay readable', () => {
    const r = summariseServiceFailures([
      fail('web', 'Container exited with code 1.\n  last logs:\n    auth.test failed: invalid_auth\n'),
    ]);
    expect(r).toContain('web: Container exited with code 1. last logs: auth.test failed: invalid_auth');
    expect(r).not.toMatch(/\n/);
  });

  it('substitutes "unknown error" when a failed result has no error string', () => {
    const r = summariseServiceFailures([
      { serviceName: 'web', action: 'create', success: false, duration: 100 },
    ]);
    expect(r).toBe('web: unknown error');
  });

  it('returns a non-empty marker when no failures are present (defensive — callers gate)', () => {
    const r = summariseServiceFailures([ok('web'), ok('worker')]);
    expect(r).toMatch(/^Apply failed/);
  });

  it('truncates with an ellipsis when the joined output exceeds the budget', () => {
    const longError = 'x'.repeat(5000);
    const r = summariseServiceFailures([fail('chatty', longError)]);
    expect(r.length).toBeLessThanOrEqual(4000);
    expect(r.endsWith('…')).toBe(true);
    // The service name should still be at the start of the truncated output —
    // operators need to know which service failed even when logs are clipped.
    expect(r.startsWith('chatty:')).toBe(true);
  });

  it('lets short messages through unchanged (no spurious ellipsis)', () => {
    const r = summariseServiceFailures([fail('w', 'short')]);
    expect(r).toBe('w: short');
    expect(r.endsWith('…')).toBe(false);
  });
});
