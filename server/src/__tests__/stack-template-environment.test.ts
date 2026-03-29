import { describe, it, expect } from 'vitest';

import { createTemplateSchema } from '../services/stacks/stack-template-schemas';

describe('Stack Template environmentId', () => {
  describe('createTemplateSchema validation', () => {
    const baseInput = {
      name: 'test-app',
      displayName: 'Test App',
      scope: 'environment' as const,
      networks: [],
      volumes: [],
      services: [
        {
          serviceName: 'web',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: 'latest',
          containerConfig: {},
          dependsOn: [],
          order: 0,
        },
      ],
    };

    it('accepts environmentId as optional string', () => {
      const result = createTemplateSchema.safeParse({
        ...baseInput,
        environmentId: 'env-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.environmentId).toBe('env-123');
      }
    });

    it('strips unknown fields like deployImmediately', () => {
      const result = createTemplateSchema.safeParse({
        ...baseInput,
        environmentId: 'env-123',
        deployImmediately: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as any).deployImmediately).toBeUndefined();
      }
    });

    it('passes without environmentId', () => {
      const result = createTemplateSchema.safeParse(baseInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.environmentId).toBeUndefined();
      }
    });

    it('rejects empty environmentId string', () => {
      const result = createTemplateSchema.safeParse({
        ...baseInput,
        environmentId: '',
      });
      expect(result.success).toBe(false);
    });
  });
});
