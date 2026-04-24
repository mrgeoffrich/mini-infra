import { describe, it, expect } from 'vitest';
import { stackDefinitionSchema } from '../schemas';

function basePool(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: 'worker',
    serviceType: 'Pool' as const,
    dockerImage: 'ghcr.io/org/worker',
    dockerTag: '1.0.0',
    dependsOn: [],
    order: 1,
    containerConfig: { env: {} },
    poolConfig: {
      defaultIdleTimeoutMinutes: 30,
      maxInstances: 50,
      managedBy: 'manager',
    },
    ...overrides,
  };
}

function baseStateful(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: 'manager',
    serviceType: 'Stateful' as const,
    dockerImage: 'ghcr.io/org/manager',
    dockerTag: '1.0.0',
    dependsOn: [],
    order: 0,
    containerConfig: { env: {} },
    ...overrides,
  };
}

function wrap(services: unknown[]) {
  return {
    name: 'slackbot',
    networks: [],
    volumes: [],
    services,
  };
}

describe('Pool service schema validation', () => {
  it('accepts a valid Pool + caller pair', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([basePool(), baseStateful()]),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a Pool service without poolConfig', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([basePool({ poolConfig: undefined }), baseStateful()]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a Pool service with routing', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        basePool({
          routing: { hostname: 'x.example.com', listeningPort: 80 },
        }),
        baseStateful(),
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects managedBy that references an unknown service', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        basePool({
          poolConfig: {
            defaultIdleTimeoutMinutes: 30,
            maxInstances: null,
            managedBy: 'does-not-exist',
          },
        }),
        baseStateful(),
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects pool-management-token dynamicEnv pointing at an unknown pool', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        basePool(),
        baseStateful({
          containerConfig: {
            env: {},
            dynamicEnv: {
              TOKEN: { kind: 'pool-management-token', poolService: 'no-such-pool' },
            },
          },
        }),
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects pool-management-token dynamicEnv pointing at a non-Pool service', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        basePool(),
        baseStateful({
          containerConfig: {
            env: {},
            dynamicEnv: {
              TOKEN: { kind: 'pool-management-token', poolService: 'manager' },
            },
          },
        }),
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a valid pool-management-token dynamicEnv', () => {
    const result = stackDefinitionSchema.safeParse(
      wrap([
        basePool(),
        baseStateful({
          containerConfig: {
            env: {},
            dynamicEnv: {
              MINI_INFRA_POOL_TOKEN: { kind: 'pool-management-token', poolService: 'worker' },
            },
          },
        }),
      ]),
    );
    expect(result.success).toBe(true);
  });
});
