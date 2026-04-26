import { describe, it, expect } from 'vitest';
import {
  buildTemplateContext,
  resolveServiceDefinition,
} from '../services/stacks/template-engine';
import type { StackServiceDefinition } from '@mini-infra/types';

function ctx(params: Record<string, string | number | boolean> = {}) {
  return buildTemplateContext(
    { name: 'app', networks: [], volumes: [] },
    [{ serviceName: 'web', dockerImage: 'nginx', dockerTag: 'latest', containerConfig: {} }],
    {
      environment: { id: 'env-1', name: 'prod', type: 'production', networkType: 'local' },
      params,
    },
  );
}

function svc(overrides: Partial<StackServiceDefinition> = {}): StackServiceDefinition {
  return {
    serviceName: 'web',
    serviceType: 'Stateful',
    dockerImage: 'nginx',
    dockerTag: 'latest',
    containerConfig: {},
    dependsOn: [],
    order: 0,
    ...overrides,
  };
}

describe('resolveServiceDefinition — numeric coercion', () => {
  it('resolves {{params.port}} to a finite number', () => {
    const s = svc({
      containerConfig: {
        ports: [{ containerPort: 80, hostPort: '{{params.port}}', protocol: 'tcp' }],
      },
    });
    const r = resolveServiceDefinition(s, ctx({ port: 8080 }));
    expect(r.containerConfig.ports?.[0].hostPort).toBe(8080);
  });

  it('coerces literal number strings back to numbers', () => {
    const s = svc({
      containerConfig: {
        ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }],
      },
    });
    const r = resolveServiceDefinition(s, ctx());
    expect(r.containerConfig.ports?.[0].hostPort).toBe(8080);
  });

  it('throws when a numeric field resolves to non-numeric content', () => {
    const s = svc({
      containerConfig: {
        ports: [{ containerPort: 80, hostPort: '{{params.port}}', protocol: 'tcp' }],
      },
    });
    expect(() => resolveServiceDefinition(s, ctx({ port: 'not-a-number' as unknown as string })))
      .toThrow(/did not resolve to a finite number/);
  });

  it('throws when healthcheck.interval is not a finite number', () => {
    const s = svc({
      containerConfig: {
        healthcheck: {
          test: ['CMD', 'true'],
          interval: '{{params.bad}}',
          timeout: 1,
          retries: 1,
          startPeriod: 0,
        },
      },
    });
    expect(() => resolveServiceDefinition(s, ctx({ bad: 'nope' })))
      .toThrow(/healthcheck\.interval/);
  });

  it('coerces exposeOnHost template string "true" to boolean true', () => {
    const s = svc({
      containerConfig: {
        ports: [{
          containerPort: 80,
          hostPort: 8080,
          protocol: 'tcp',
          exposeOnHost: '{{params.expose}}',
        }],
      },
    });
    const r = resolveServiceDefinition(s, ctx({ expose: true }));
    expect(r.containerConfig.ports?.[0].exposeOnHost).toBe(true);
  });

  it('coerces exposeOnHost template string "false" to boolean false', () => {
    const s = svc({
      containerConfig: {
        ports: [{
          containerPort: 80,
          hostPort: 8080,
          protocol: 'tcp',
          exposeOnHost: '{{params.expose}}',
        }],
      },
    });
    const r = resolveServiceDefinition(s, ctx({ expose: false }));
    expect(r.containerConfig.ports?.[0].exposeOnHost).toBe(false);
  });
});
