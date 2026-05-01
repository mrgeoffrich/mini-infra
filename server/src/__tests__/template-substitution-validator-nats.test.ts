/**
 * Phase 1 — substitution validator coverage for the new NATS app-author
 * surface (subjectPrefix, roles[].publish/subscribe, signers[].subjectScope,
 * exports[], imports[]). Same allowed namespaces as the vault section: the
 * `inputs` namespace is KV-only and must NOT be accepted in NATS fields.
 */

import { describe, it, expect } from 'vitest';
import { validateTemplateSubstitutions } from '../services/stacks/template-substitution-validator';

function make(over: Partial<Parameters<typeof validateTemplateSubstitutions>[0]> = {}) {
  return {
    scope: 'environment' as const,
    parameterNames: new Set<string>(),
    inputNames: new Set<string>(),
    services: [],
    configFiles: [],
    networks: [],
    volumes: [],
    resourceInputs: [],
    resourceOutputs: [],
    ...over,
  };
}

describe('validateTemplateSubstitutions — nats.subjectPrefix', () => {
  it('accepts {{stack.id}} in subjectPrefix', () => {
    const issues = validateTemplateSubstitutions(
      make({ natsSubjectPrefix: 'app.{{stack.id}}' }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects unknown stack key', () => {
    const issues = validateTemplateSubstitutions(
      make({ natsSubjectPrefix: 'app.{{stack.uuid}}' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('nats.subjectPrefix');
    expect(issues[0].message).toContain("unknown stack key 'uuid'");
  });

  it('rejects {{environment.*}} on host-scoped template', () => {
    const issues = validateTemplateSubstitutions(
      make({ scope: 'host', natsSubjectPrefix: 'app.{{environment.name}}' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('nats.subjectPrefix');
    expect(issues[0].message).toContain('host-scoped');
  });
});

describe('validateTemplateSubstitutions — nats.roles', () => {
  it('accepts {{params.x}} inside role publish/subscribe patterns', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['tenant']),
        natsRoles: [
          {
            name: 'gateway',
            publish: ['agent.{{params.tenant}}.in'],
            subscribe: ['agent.{{params.tenant}}.out'],
          },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('flags unknown parameter inside role pattern', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['tenant']),
        natsRoles: [{ name: 'gateway', publish: ['agent.{{params.tenat}}.in'] }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].token).toBe('{{params.tenat}}');
    expect(issues[0].path).toContain('nats.roles');
  });

  it('rejects {{inputs.*}} inside role pattern (inputs namespace is KV-only)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['tenant']),
        natsRoles: [{ name: 'gateway', subscribe: ['agent.{{inputs.tenant}}.out'] }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].token).toBe('{{inputs.tenant}}');
    expect(issues[0].message).toContain('inputs');
  });
});

describe('validateTemplateSubstitutions — nats.signers', () => {
  it('accepts {{stack.id}} inside signer subjectScope', () => {
    const issues = validateTemplateSubstitutions(
      make({
        natsSigners: [
          { name: 'worker-minter', subjectScope: 'agent.worker.{{stack.id}}' },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects unknown namespace in signer subjectScope', () => {
    const issues = validateTemplateSubstitutions(
      make({
        natsSigners: [
          { name: 'worker-minter', subjectScope: 'agent.worker.{{user.name}}' },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].token).toBe('{{user.name}}');
    expect(issues[0].path).toContain('nats.signers');
  });
});

describe('validateTemplateSubstitutions — nats.exports / nats.imports', () => {
  it('accepts substitutions in export subjects', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['tenant']),
        natsExports: ['events.{{params.tenant}}.>'],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('flags unknown parameter in import subjects', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set([]),
        natsImports: [
          { fromStack: 'producer', subjects: ['events.{{params.tenant}}.>'], forRoles: ['watcher'] },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].token).toBe('{{params.tenant}}');
    expect(issues[0].path).toContain('nats.imports');
  });

  it('environment-scoped imports accept {{environment.name}}', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'environment',
        natsImports: [
          { fromStack: 'producer-{{environment.name}}', subjects: ['events.>'], forRoles: ['watcher'] },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('host-scoped imports rejecting {{environment.name}}', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'host',
        natsImports: [
          { fromStack: 'producer-{{environment.name}}', subjects: ['events.>'], forRoles: ['watcher'] },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('host-scoped');
  });
});
