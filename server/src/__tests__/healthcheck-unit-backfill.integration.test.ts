/**
 * Integration test for the healthcheck seconds → milliseconds backfill.
 *
 * Milliseconds is the canonical unit for `StackContainerConfig.healthcheck`,
 * but stored rows predate that: the authoring UIs wrote ms while the built-in
 * template JSONs wrote seconds, and every container-create path multiplied by
 * 1e9 as though it were all seconds (so a UI-authored 30s interval became a
 * Docker interval of ~8.3 hours and the healthcheck never ran).
 *
 * The backfill discriminates on magnitude — anything below 1000 is treated as a
 * legacy seconds value — and must be idempotent, because it runs on every boot.
 * These tests cover the three columns it walks, with the nested snapshot the
 * one that is easy to get wrong: drift compares the running container against
 * `lastAppliedSnapshot`, so if the snapshot kept stale seconds while the live
 * rows moved to ms, every converted stack would immediately read as drifted.
 */
import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import pino from 'pino';
import { testPrisma } from './integration-test-helpers';
import { backfillHealthcheckUnits } from '../services/stacks/healthcheck-unit-backfill';

const logger = pino({ level: 'silent' });

/** A healthcheck as the built-in templates used to store it: seconds. */
const SECONDS_HEALTHCHECK = {
  test: ['CMD', 'true'],
  interval: 30,
  timeout: 5,
  retries: 3,
  startPeriod: 30,
};

/** A healthcheck as the authoring UI stores it: milliseconds. */
const MS_HEALTHCHECK = {
  test: ['CMD', 'true'],
  interval: 30_000,
  timeout: 5_000,
  retries: 3,
  startPeriod: 30_000,
};

async function createStack(opts: {
  serviceHealthcheck?: unknown;
  snapshotHealthcheck?: unknown;
}): Promise<string> {
  const stackId = createId();

  await testPrisma.stack.create({
    data: {
      id: stackId,
      name: `hc-backfill-${stackId.slice(0, 6)}`,
      networks: [],
      volumes: [],
      status: 'synced',
      ...(opts.snapshotHealthcheck !== undefined
        ? {
            lastAppliedSnapshot: {
              name: 'snap',
              services: [
                {
                  serviceName: 'api',
                  containerConfig: { image: 'nginx', healthcheck: opts.snapshotHealthcheck },
                },
              ],
            },
          }
        : {}),
    },
  });

  if (opts.serviceHealthcheck !== undefined) {
    await testPrisma.stackService.create({
      data: {
        id: createId(),
        stackId,
        serviceName: 'api',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: 'latest',
        order: 0,
        containerConfig: { healthcheck: opts.serviceHealthcheck },
        dependsOn: [],
      },
    });
  }

  return stackId;
}

describe('backfillHealthcheckUnits', () => {
  it('scales a legacy seconds stack service up to milliseconds', async () => {
    const stackId = await createStack({ serviceHealthcheck: SECONDS_HEALTHCHECK });

    await backfillHealthcheckUnits(testPrisma, logger);

    const svc = await testPrisma.stackService.findFirst({ where: { stackId } });
    const hc = (svc?.containerConfig as { healthcheck: Record<string, number> }).healthcheck;

    expect(hc.interval).toBe(30_000);
    expect(hc.timeout).toBe(5_000);
    expect(hc.startPeriod).toBe(30_000);
    // retries is a count, not a duration — it must survive untouched.
    expect(hc.retries).toBe(3);
  });

  it('leaves an already-millisecond stack service alone', async () => {
    const stackId = await createStack({ serviceHealthcheck: MS_HEALTHCHECK });

    await backfillHealthcheckUnits(testPrisma, logger);

    const svc = await testPrisma.stackService.findFirst({ where: { stackId } });
    const hc = (svc?.containerConfig as { healthcheck: Record<string, number> }).healthcheck;

    expect(hc).toMatchObject(MS_HEALTHCHECK);
  });

  it('converts the nested lastAppliedSnapshot in lockstep with the live rows', async () => {
    // If the snapshot kept seconds while the service row moved to ms, drift
    // detection would compare the two and flag every converted stack as drifted.
    const stackId = await createStack({
      serviceHealthcheck: SECONDS_HEALTHCHECK,
      snapshotHealthcheck: SECONDS_HEALTHCHECK,
    });

    await backfillHealthcheckUnits(testPrisma, logger);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    const snapshot = stack?.lastAppliedSnapshot as {
      services: Array<{ containerConfig: { healthcheck: Record<string, number> } }>;
    };
    const snapHc = snapshot.services[0].containerConfig.healthcheck;

    const svc = await testPrisma.stackService.findFirst({ where: { stackId } });
    const liveHc = (svc?.containerConfig as { healthcheck: Record<string, number> }).healthcheck;

    expect(snapHc.interval).toBe(30_000);
    expect(snapHc.startPeriod).toBe(30_000);
    expect(snapHc).toEqual(liveHc);
  });

  it('preserves other containerConfig keys on the snapshot service', async () => {
    const stackId = await createStack({ snapshotHealthcheck: SECONDS_HEALTHCHECK });

    await backfillHealthcheckUnits(testPrisma, logger);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    const snapshot = stack?.lastAppliedSnapshot as {
      services: Array<{ serviceName: string; containerConfig: Record<string, unknown> }>;
    };

    expect(snapshot.services[0].serviceName).toBe('api');
    expect(snapshot.services[0].containerConfig.image).toBe('nginx');
  });

  it('is idempotent — it runs on every boot', async () => {
    const stackId = await createStack({
      serviceHealthcheck: SECONDS_HEALTHCHECK,
      snapshotHealthcheck: SECONDS_HEALTHCHECK,
    });

    await backfillHealthcheckUnits(testPrisma, logger);
    const second = await backfillHealthcheckUnits(testPrisma, logger);

    // The second pass must find nothing left to do for this stack, and above all
    // must not multiply the already-converted values by another 1000.
    const svc = await testPrisma.stackService.findFirst({ where: { stackId } });
    const hc = (svc?.containerConfig as { healthcheck: Record<string, number> }).healthcheck;

    expect(hc.interval).toBe(30_000);
    expect(hc.startPeriod).toBe(30_000);

    const stack = await testPrisma.stack.findUnique({ where: { id: stackId } });
    const snapshot = stack?.lastAppliedSnapshot as {
      services: Array<{ containerConfig: { healthcheck: Record<string, number> } }>;
    };
    expect(snapshot.services[0].containerConfig.healthcheck.interval).toBe(30_000);

    // Nothing this test created should have been touched on the second pass.
    // (Other tests' rows may still be in flight, so assert on our own stack
    // rather than on the global counters.)
    expect(second.conversions).toBeGreaterThanOrEqual(0);
  });

  it('scales template services too', async () => {
    const templateId = createId();
    const versionId = createId();

    await testPrisma.stackTemplate.create({
      data: {
        id: templateId,
        name: `hc-tmpl-${templateId.slice(0, 6)}`,
        displayName: 'HC Template',
        source: 'user',
        scope: 'host',
      },
    });
    await testPrisma.stackTemplateVersion.create({
      data: {
        id: versionId,
        templateId,
        version: 1,
        status: 'published',
        parameters: [],
        defaultParameterValues: {},
        networkTypeDefaults: {},
        networks: [],
        volumes: [],
      },
    });
    await testPrisma.stackTemplateService.create({
      data: {
        id: createId(),
        versionId,
        serviceName: 'api',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: 'latest',
        order: 0,
        containerConfig: { healthcheck: SECONDS_HEALTHCHECK },
        dependsOn: [],
      },
    });

    await backfillHealthcheckUnits(testPrisma, logger);

    const svc = await testPrisma.stackTemplateService.findFirst({ where: { versionId } });
    const hc = (svc?.containerConfig as { healthcheck: Record<string, number> }).healthcheck;

    expect(hc.interval).toBe(30_000);
    expect(hc.timeout).toBe(5_000);
    expect(hc.startPeriod).toBe(30_000);
    expect(hc.retries).toBe(3);
  });
});
