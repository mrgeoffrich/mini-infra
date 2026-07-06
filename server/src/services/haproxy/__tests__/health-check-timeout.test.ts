import { describe, it, expect } from 'vitest';
import {
  resolveHealthCheckTimeoutMs,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  MAX_HEALTH_CHECK_TIMEOUT_MS,
} from '../health-check-timeout';

describe('resolveHealthCheckTimeoutMs', () => {
  it('falls back to the 90s default when startPeriod is unset', () => {
    expect(resolveHealthCheckTimeoutMs(undefined)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(null)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
  });

  it('falls back to the default for non-positive or non-finite values', () => {
    expect(resolveHealthCheckTimeoutMs(0)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(-5_000)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(Number.NaN)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
  });

  it('floors at the 90s default so we never regress below the historical timeout', () => {
    // A shorter startPeriod (e.g. 30s) still gets the 90s floor — the timeout
    // is an upper bound on the wait, so flooring never slows a healthy deploy.
    expect(resolveHealthCheckTimeoutMs(30_000)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(DEFAULT_HEALTH_CHECK_TIMEOUT_MS)).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
  });

  it('honours a longer startPeriod verbatim for slow-booting images', () => {
    // The Kumiko case: ~1 GB CAD kernel import needs > 90s before binding.
    expect(resolveHealthCheckTimeoutMs(180_000)).toBe(180_000);
    expect(resolveHealthCheckTimeoutMs(300_000)).toBe(300_000);
  });

  it('caps at the 10-minute maximum so a misconfig cannot hang a deploy', () => {
    expect(resolveHealthCheckTimeoutMs(3_600_000)).toBe(MAX_HEALTH_CHECK_TIMEOUT_MS);
    expect(resolveHealthCheckTimeoutMs(MAX_HEALTH_CHECK_TIMEOUT_MS + 1)).toBe(MAX_HEALTH_CHECK_TIMEOUT_MS);
  });
});
