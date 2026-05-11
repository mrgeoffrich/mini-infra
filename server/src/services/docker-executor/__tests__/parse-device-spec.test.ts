import { describe, it, expect } from 'vitest';
import { parseDeviceSpec } from '../utils';

// Helper that translates one `containerConfig.devices[]` entry into the
// dockerode `HostConfig.Devices` shape. Phase 3.5 — keeps the claude-shell
// `/dev/net/tun` claim landing on the running container as it was authored.
describe('parseDeviceSpec', () => {
  it('parses a bare device path (host == container, perms default to rwm)', () => {
    expect(parseDeviceSpec('/dev/net/tun')).toEqual({
      PathOnHost: '/dev/net/tun',
      PathInContainer: '/dev/net/tun',
      CgroupPermissions: 'rwm',
    });
  });

  it('parses HOST:CONTAINER (perms default to rwm)', () => {
    expect(parseDeviceSpec('/dev/host-side:/dev/in-container')).toEqual({
      PathOnHost: '/dev/host-side',
      PathInContainer: '/dev/in-container',
      CgroupPermissions: 'rwm',
    });
  });

  it('parses HOST:CONTAINER:PERMS verbatim', () => {
    expect(parseDeviceSpec('/dev/host:/dev/container:rw')).toEqual({
      PathOnHost: '/dev/host',
      PathInContainer: '/dev/container',
      CgroupPermissions: 'rw',
    });
  });

  it('rejects an empty string', () => {
    expect(() => parseDeviceSpec('')).toThrow(/non-empty string/);
  });

  it('rejects more than three segments', () => {
    expect(() => parseDeviceSpec('/dev/host:/dev/container:rw:extra')).toThrow(/HOST:CONTAINER:PERMS/);
  });

  it('rejects empty segments', () => {
    expect(() => parseDeviceSpec('/dev/host::rw')).toThrow(/empty segments/);
    expect(() => parseDeviceSpec(':/dev/container')).toThrow(/empty segments/);
    expect(() => parseDeviceSpec('/dev/host:')).toThrow(/empty segments/);
  });
});
