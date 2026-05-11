import { describe, it, expect } from 'vitest';
import { computeDefinitionHash } from '../definition-hash';
import type { JobPoolConfig, StackServiceDefinition } from '@mini-infra/types';

/**
 * Phase 3 invariant: a JobPool service's definition hash must include the
 * triggers / history / killAfterSeconds / onFailure fields so the plan-and-
 * apply flow detects drift when an operator edits any of them. The
 * running-or-not state of `PoolInstance` rows is NOT in the hash — that
 * oscillates per-run and is not drift.
 */
describe('definition-hash with JobPool config', () => {
  const baseJobPoolConfig: JobPoolConfig = {
    maxConcurrent: 2,
    managedBy: null,
    triggers: [{ kind: 'cron', schedule: '0 2 * * *', name: 'nightly' }],
    history: { retainDays: 14 },
  };

  const baseService: StackServiceDefinition = {
    serviceName: 'backup',
    serviceType: 'JobPool',
    dockerImage: 'ghcr.io/org/backup',
    dockerTag: '1.0.0',
    dependsOn: [],
    order: 1,
    containerConfig: { env: {} },
    jobPoolConfig: baseJobPoolConfig,
  };

  it('changing triggers[] changes the hash', () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: {
        ...baseJobPoolConfig,
        triggers: [
          { kind: 'cron', schedule: '0 2 * * *', name: 'nightly' },
          { kind: 'manual', name: 'go' },
        ],
      },
    });
    expect(a).not.toBe(b);
  });

  it('changing history.retainDays changes the hash', () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: { ...baseJobPoolConfig, history: { retainDays: 30 } },
    });
    expect(a).not.toBe(b);
  });

  it('changing killAfterSeconds changes the hash', () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: { ...baseJobPoolConfig, killAfterSeconds: 600 },
    });
    expect(a).not.toBe(b);
  });

  it('changing onFailure changes the hash', () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: {
        ...baseJobPoolConfig,
        onFailure: { retries: 3, backoff: 'exponential' },
      },
    });
    expect(a).not.toBe(b);
  });

  it('changing maxConcurrent does NOT change the hash (cap is registry-tunable, not drift)', () => {
    // The plan: maxConcurrent is tunable at apply time without forcing a
    // service recreate — the registries pick it up from the row on each
    // refresh and the cap-check runs against the current value at trigger
    // fire time.
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: { ...baseJobPoolConfig, maxConcurrent: 5 },
    });
    expect(a).toBe(b);
  });

  it('reordering triggers[] does NOT change the hash (canonical sort)', () => {
    const a = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: {
        ...baseJobPoolConfig,
        triggers: [
          { kind: 'manual', name: 'go' },
          { kind: 'cron', schedule: '0 2 * * *', name: 'nightly' },
        ],
      },
    });
    const b = computeDefinitionHash({
      ...baseService,
      jobPoolConfig: {
        ...baseJobPoolConfig,
        triggers: [
          { kind: 'cron', schedule: '0 2 * * *', name: 'nightly' },
          { kind: 'manual', name: 'go' },
        ],
      },
    });
    expect(a).toBe(b);
  });

  it('Stateful service hash is unaffected by the JobPool branch', () => {
    // Sanity check: the new JobPool field set on the canonical form is
    // gated by serviceType === 'JobPool'. A Stateful service must keep
    // hashing the same as it did before this phase.
    const stateful: StackServiceDefinition = {
      serviceName: 'app',
      serviceType: 'Stateful',
      dockerImage: 'nginx',
      dockerTag: 'latest',
      dependsOn: [],
      order: 1,
      containerConfig: { env: { FOO: 'bar' } },
    };
    const before = computeDefinitionHash(stateful);
    // Repeating with explicit `null` jobPoolConfig (matching the legacy
    // input shape) — must produce the same hash because that field is
    // ignored on non-JobPool services.
    const after = computeDefinitionHash({
      ...stateful,
      jobPoolConfig: null,
    });
    expect(before).toBe(after);
  });
});
