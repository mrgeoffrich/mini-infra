import { computeDefinitionHash } from '../services/stacks/definition-hash';
import { StackServiceDefinition, StackConfigFile } from '@mini-infra/types';

function makeService(overrides: Partial<StackServiceDefinition> = {}): StackServiceDefinition {
  return {
    serviceName: 'loki',
    serviceType: 'Stateful',
    dockerImage: 'grafana/loki',
    dockerTag: '2.9.0',
    containerConfig: {
      env: { LOG_LEVEL: 'info' },
      restartPolicy: 'unless-stopped',
    },
    configFiles: [
      { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'server:\n  http_listen_port: 3100' },
    ],
    initCommands: [
      { volumeName: 'data', mountPath: '/loki', commands: ['chown 10001:10001 /loki'] },
    ],
    dependsOn: [],
    order: 1,
    routing: {
      hostname: 'loki.example.com',
      listeningPort: 3100,
    },
    ...overrides,
  };
}

describe('computeDefinitionHash', () => {
  it('produces a deterministic hash for the same input', () => {
    const svc = makeService();
    expect(computeDefinitionHash(svc)).toBe(computeDefinitionHash(svc));
  });

  it('produces the same hash regardless of containerConfig key order', () => {
    const svc1 = makeService({
      containerConfig: { env: { A: '1' }, restartPolicy: 'always' },
    });
    const svc2 = makeService({
      containerConfig: { restartPolicy: 'always', env: { A: '1' } },
    });
    expect(computeDefinitionHash(svc1)).toBe(computeDefinitionHash(svc2));
  });

  it('changes hash when dockerTag changes', () => {
    const svc1 = makeService({ dockerTag: '2.9.0' });
    const svc2 = makeService({ dockerTag: '3.0.0' });
    expect(computeDefinitionHash(svc1)).not.toBe(computeDefinitionHash(svc2));
  });

  it('changes hash when config file content changes', () => {
    const svc1 = makeService();
    const svc2 = makeService({
      configFiles: [
        { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'server:\n  http_listen_port: 9090' },
      ],
    });
    expect(computeDefinitionHash(svc1)).not.toBe(computeDefinitionHash(svc2));
  });

  it('produces the same hash regardless of config file order', () => {
    const file1: StackConfigFile = { volumeName: 'a', path: '/a.conf', content: 'a' };
    const file2: StackConfigFile = { volumeName: 'b', path: '/b.conf', content: 'b' };
    const svc1 = makeService({ configFiles: [file1, file2] });
    const svc2 = makeService({ configFiles: [file2, file1] });
    expect(computeDefinitionHash(svc1)).toBe(computeDefinitionHash(svc2));
  });

  it('changes hash when init commands change', () => {
    const svc1 = makeService();
    const svc2 = makeService({
      initCommands: [
        { volumeName: 'data', mountPath: '/loki', commands: ['chmod 755 /loki'] },
      ],
    });
    expect(computeDefinitionHash(svc1)).not.toBe(computeDefinitionHash(svc2));
  });

  it('changes hash when routing changes', () => {
    const svc1 = makeService();
    const svc2 = makeService({
      routing: { hostname: 'other.example.com', listeningPort: 3100 },
    });
    expect(computeDefinitionHash(svc1)).not.toBe(computeDefinitionHash(svc2));
  });

  it('treats null and undefined routing the same', () => {
    const svc1 = makeService({ routing: undefined });
    const svc2 = makeService({ routing: undefined });
    // Both should resolve routing to null
    expect(computeDefinitionHash(svc1)).toBe(computeDefinitionHash(svc2));
  });

  it('uses resolvedConfigFiles when provided instead of service.configFiles', () => {
    const svc = makeService();
    const resolved: StackConfigFile[] = [
      { volumeName: 'config', path: '/etc/loki/config.yaml', content: 'resolved content' },
    ];
    const hashWithOriginal = computeDefinitionHash(svc);
    const hashWithResolved = computeDefinitionHash(svc, resolved);
    expect(hashWithOriginal).not.toBe(hashWithResolved);
  });

  it('returns hash prefixed with sha256:', () => {
    const hash = computeDefinitionHash(makeService());
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
