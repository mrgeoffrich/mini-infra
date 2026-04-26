import { describe, it, expect } from 'vitest';
import {
  validateTemplateSubstitutions,
  parameterNamesFromDefinitions,
} from '../services/stacks/template-substitution-validator';

function make(over: Partial<Parameters<typeof validateTemplateSubstitutions>[0]> = {}) {
  return {
    scope: 'environment',
    parameterNames: new Set<string>(),
    services: [],
    configFiles: [],
    networks: [],
    volumes: [],
    resourceInputs: [],
    resourceOutputs: [],
    ...over,
  };
}

describe('validateTemplateSubstitutions — happy paths', () => {
  it('accepts a template with no substitutions', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ serviceName: 'web', containerConfig: { env: { K: 'literal' } } }] }),
    );
    expect(issues).toEqual([]);
  });

  it('accepts {{params.X}} when X is defined', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['port']),
        services: [{ serviceName: 'w', containerConfig: { env: { PORT: '{{params.port}}' } } }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('accepts all stack.* keys', () => {
    for (const key of ['id', 'name', 'projectName']) {
      const issues = validateTemplateSubstitutions(
        make({ services: [{ containerConfig: { env: { K: `{{stack.${key}}}` } } }] }),
      );
      expect(issues, `stack.${key} should be allowed`).toEqual([]);
    }
  });

  it('accepts all environment.* keys when scope is environment', () => {
    for (const key of ['id', 'name', 'type', 'networkType']) {
      const issues = validateTemplateSubstitutions(
        make({ services: [{ containerConfig: { env: { K: `{{environment.${key}}}` } } }] }),
      );
      expect(issues, `environment.${key} should be allowed`).toEqual([]);
    }
  });

  it('accepts substitutions inside configFiles content and command arrays', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['name']),
        configFiles: [{ content: 'hostname: {{params.name}}' }],
        services: [{ containerConfig: { command: ['--id', '{{stack.id}}'] } }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('accepts whitespace inside the braces', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ containerConfig: { env: { K: '{{ stack.id }}' } } }] }),
    );
    expect(issues).toEqual([]);
  });
});

describe('validateTemplateSubstitutions — typo detection', () => {
  it('rejects {{stak.id}} (typo in namespace)', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ containerConfig: { env: { K: '{{stak.id}}' } } }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown namespace 'stak'/);
  });

  it('rejects {{stack.idd}} (typo in stack key)', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ containerConfig: { env: { K: '{{stack.idd}}' } } }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown stack key 'idd'/);
  });

  it('rejects {{environment.foo}} (typo in environment key)', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ containerConfig: { env: { K: '{{environment.foo}}' } } }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown environment key 'foo'/);
  });

  it('rejects {{params.unknown}} (parameter not defined)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        parameterNames: new Set(['port']),
        services: [{ containerConfig: { env: { K: '{{params.unknown}}' } } }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown parameter 'unknown'/);
    expect(issues[0].message).toMatch(/'port'/); // Lists what IS defined
  });

  it('rejects {{noNamespace}} (missing namespace)', () => {
    const issues = validateTemplateSubstitutions(
      make({ services: [{ containerConfig: { env: { K: '{{noNamespace}}' } } }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/missing a namespace/);
  });
});

describe('validateTemplateSubstitutions — host-scope guard', () => {
  it('rejects {{environment.*}} on host-scoped templates', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'host',
        services: [{ containerConfig: { env: { K: '{{environment.name}}' } } }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/host-scoped/);
  });

  it('still accepts {{stack.*}} on host-scoped templates', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'host',
        services: [{ containerConfig: { env: { K: '{{stack.id}}' } } }],
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe('validateTemplateSubstitutions — issue locations', () => {
  it('reports JSON-pointer-style paths so authors can locate the issue', () => {
    const issues = validateTemplateSubstitutions(
      make({
        services: [
          { containerConfig: {} },
          { containerConfig: { env: { SLACK_TOKEN: '{{stak.id}}' } } },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('services[1].containerConfig.env.SLACK_TOKEN');
  });

  it('collects all issues in a single pass (does not bail on first)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        services: [
          { containerConfig: { env: { A: '{{stak.id}}', B: '{{environment.foo}}' } } },
        ],
        configFiles: [{ content: '{{params.unknown}}' }],
      }),
    );
    expect(issues).toHaveLength(3);
  });

  it('reports multiple substitutions inside a single string separately', () => {
    const issues = validateTemplateSubstitutions(
      make({
        services: [
          { containerConfig: { env: { K: 'host={{stak.id}} env={{environment.bad}}' } } },
        ],
      }),
    );
    expect(issues).toHaveLength(2);
  });
});

describe('parameterNamesFromDefinitions', () => {
  it('extracts names from parameter definitions', () => {
    expect(
      parameterNamesFromDefinitions([
        { name: 'a', type: 'string', default: '' },
        { name: 'b', type: 'number', default: 0 },
      ]),
    ).toEqual(new Set(['a', 'b']));
  });

  it('returns an empty set for undefined input', () => {
    expect(parameterNamesFromDefinitions(undefined)).toEqual(new Set());
  });
});
