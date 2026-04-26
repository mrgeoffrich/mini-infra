import {
  buildTemplateContext,
  resolveTemplate,
  resolveStackConfigFiles,
  TemplateContext,
} from '../services/stacks/template-engine';
import { StackConfigFile } from '@mini-infra/types';

function makeContext(): TemplateContext {
  return buildTemplateContext(
    {
      name: 'monitoring',
      networks: [{ name: 'monitoring_network' }],
      volumes: [{ name: 'loki_data' }],
    },
    [
      {
        serviceName: 'loki',
        dockerImage: 'grafana/loki',
        dockerTag: '2.9.0',
        containerConfig: { env: { LOG_LEVEL: 'info', RETENTION: '30d' } },
      },
      {
        serviceName: 'grafana',
        dockerImage: 'grafana/grafana',
        dockerTag: '10.0.0',
        containerConfig: {},
      },
    ],
    {
      stackId: 'stk_abc123',
      environment: { id: 'env_xyz', name: 'prod', type: 'production', networkType: 'internet' },
    }
  );
}

describe('resolveTemplate', () => {
  const ctx = makeContext();

  it('resolves {{stack.name}}', () => {
    expect(resolveTemplate('name={{stack.name}}', ctx)).toBe('name=monitoring');
  });

  it('resolves {{stack.projectName}}', () => {
    expect(resolveTemplate('{{stack.projectName}}', ctx)).toBe('prod-monitoring');
  });

  it('resolves {{services.loki.containerName}}', () => {
    expect(resolveTemplate('{{services.loki.containerName}}', ctx)).toBe('prod-monitoring-loki');
  });

  it('resolves {{services.loki.image}}', () => {
    expect(resolveTemplate('{{services.loki.image}}', ctx)).toBe('grafana/loki:2.9.0');
  });

  it('resolves {{env.LOG_LEVEL}}', () => {
    expect(resolveTemplate('{{env.LOG_LEVEL}}', ctx)).toBe('info');
  });

  it('resolves {{volumes.loki_data}}', () => {
    expect(resolveTemplate('{{volumes.loki_data}}', ctx)).toBe('prod-monitoring_loki_data');
  });

  it('resolves {{networks.monitoring_network}}', () => {
    expect(resolveTemplate('{{networks.monitoring_network}}', ctx)).toBe(
      'prod-monitoring_monitoring_network'
    );
  });

  it('resolves multiple variables in one string', () => {
    const result = resolveTemplate(
      'image={{services.loki.image}} level={{env.LOG_LEVEL}}',
      ctx
    );
    expect(result).toBe('image=grafana/loki:2.9.0 level=info');
  });

  it('throws on unknown variable', () => {
    expect(() => resolveTemplate('{{services.nonexistent.containerName}}', ctx)).toThrow(
      'Unresolved template variable'
    );
  });

  it('returns plain string unchanged', () => {
    expect(resolveTemplate('no variables here', ctx)).toBe('no variables here');
  });

  it('resolves {{stack.id}} when stackId provided', () => {
    expect(resolveTemplate('id={{stack.id}}', ctx)).toBe('id=stk_abc123');
  });

  it('resolves {{environment.id}}, {{environment.name}}, {{environment.type}}, {{environment.networkType}}', () => {
    expect(resolveTemplate('{{environment.id}}', ctx)).toBe('env_xyz');
    expect(resolveTemplate('{{environment.name}}', ctx)).toBe('prod');
    expect(resolveTemplate('{{environment.type}}', ctx)).toBe('production');
    expect(resolveTemplate('{{environment.networkType}}', ctx)).toBe('internet');
  });

  it('throws when {{stack.id}} is referenced but not provided', () => {
    const noIdCtx = buildTemplateContext(
      { name: 'app', networks: [], volumes: [] },
      [{ serviceName: 'web', dockerImage: 'nginx', dockerTag: 'latest', containerConfig: {} }],
      {},
    );
    expect(() => resolveTemplate('{{stack.id}}', noIdCtx)).toThrow('Unresolved template variable');
  });

  it('throws when {{environment.*}} is referenced on a host-scoped stack (no environment)', () => {
    const hostCtx = buildTemplateContext(
      { name: 'app', networks: [], volumes: [] },
      [{ serviceName: 'web', dockerImage: 'nginx', dockerTag: 'latest', containerConfig: {} }],
      {},
    );
    expect(() => resolveTemplate('{{environment.name}}', hostCtx)).toThrow('Unresolved template variable');
  });
});

describe('buildTemplateContext', () => {
  it('produces correct context from stack, services, and envName', () => {
    const ctx = makeContext();
    expect(ctx.stack.name).toBe('monitoring');
    expect(ctx.stack.projectName).toBe('prod-monitoring');
    expect(ctx.services.loki.containerName).toBe('prod-monitoring-loki');
    expect(ctx.services.loki.image).toBe('grafana/loki:2.9.0');
    expect(ctx.services.grafana.containerName).toBe('prod-monitoring-grafana');
    expect(ctx.env.LOG_LEVEL).toBe('info');
    expect(ctx.env.RETENTION).toBe('30d');
    expect(ctx.volumes.loki_data).toBe('prod-monitoring_loki_data');
    expect(ctx.networks.monitoring_network).toBe('prod-monitoring_monitoring_network');
  });
});

describe('resolveStackConfigFiles', () => {
  it('resolves templates in all config file contents', () => {
    const ctx = makeContext();
    const files: StackConfigFile[] = [
      {
        volumeName: 'config',
        path: '/etc/loki/config.yaml',
        content: 'container: {{services.loki.containerName}}',
      },
      {
        volumeName: 'config',
        path: '/etc/loki/env.yaml',
        content: 'level: {{env.LOG_LEVEL}}',
      },
    ];
    const resolved = resolveStackConfigFiles(files, ctx);
    expect(resolved[0].content).toBe('container: prod-monitoring-loki');
    expect(resolved[1].content).toBe('level: info');
    // Non-content fields unchanged
    expect(resolved[0].volumeName).toBe('config');
    expect(resolved[0].path).toBe('/etc/loki/config.yaml');
  });
});
