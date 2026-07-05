import { describe, it, expect } from 'vitest';
import { resolveStackMountSource, mountsToDeploymentVolumes } from '../stack-mounts';

describe('resolveStackMountSource', () => {
  it('prefixes a named volume with the project name (matches reconciler volume creation)', () => {
    // stack-reconciler.ts creates the volume as `${projectName}_${vol.name}`,
    // so the mount source must resolve to the same string or the container
    // mounts a different (empty) volume.
    expect(
      resolveStackMountSource({ source: 'kumiko-logs', type: 'volume' }, 'internet-kumiko-designer-website'),
    ).toBe('internet-kumiko-designer-website_kumiko-logs');
  });

  it('passes a bind mount (absolute host path) through unchanged', () => {
    expect(resolveStackMountSource({ source: '/srv/data', type: 'bind' }, 'proj')).toBe('/srv/data');
  });

  it('does not prefix a volume-typed source that already contains a slash', () => {
    expect(resolveStackMountSource({ source: '/host/path', type: 'volume' }, 'proj')).toBe('/host/path');
  });
});

describe('mountsToDeploymentVolumes', () => {
  it('maps declared mounts to pre-resolved DeploymentVolumes', () => {
    const result = mountsToDeploymentVolumes(
      [
        { source: 'kumiko-logs', target: '/logs', type: 'volume' },
        { source: 'kumiko-data', target: '/data', type: 'volume', readOnly: true },
      ],
      'proj',
    );
    // preResolved: true is load-bearing — it stops container-lifecycle-manager
    // from re-applying its `${environmentName}-` prefix to an already-final name.
    expect(result).toEqual([
      { hostPath: 'proj_kumiko-logs', containerPath: '/logs', mode: 'rw', preResolved: true },
      { hostPath: 'proj_kumiko-data', containerPath: '/data', mode: 'ro', preResolved: true },
    ]);
  });

  it('returns an empty array when there are no mounts', () => {
    expect(mountsToDeploymentVolumes(undefined, 'proj')).toEqual([]);
  });
});
