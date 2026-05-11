import { describe, it, expect } from 'vitest';
import { stackContainerConfigSchema } from '../services/stacks/schemas';

// Phase 3.5 regression: containerConfig.devices was added to the lib type in
// Phase 3 so the env-injection branch of the claude-shell addon could ask
// for `/dev/net/tun`, but the Zod schema didn't declare the field. With
// Zod's strip-unknown default, the value would silently disappear at the
// HTTP boundary so operator-authored devices would never reach Docker.
//
// These tests pin both the happy path (string-array accepted) and the type
// rejections so a future schema reshuffle can't regress to silent strip.
describe('stackContainerConfigSchema.devices', () => {
  it('accepts a bare device path', () => {
    const r = stackContainerConfigSchema.safeParse({ devices: ['/dev/net/tun'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.devices).toEqual(['/dev/net/tun']);
  });

  it('accepts HOST:CONTAINER and HOST:CONTAINER:PERMS forms verbatim (parsing happens at create time)', () => {
    const r = stackContainerConfigSchema.safeParse({
      devices: ['/dev/host:/dev/container', '/dev/host:/dev/container:rw'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.devices).toEqual([
        '/dev/host:/dev/container',
        '/dev/host:/dev/container:rw',
      ]);
    }
  });

  it('accepts an omitted devices field', () => {
    const r = stackContainerConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.devices).toBeUndefined();
  });

  it('rejects a non-array value', () => {
    const r = stackContainerConfigSchema.safeParse({ devices: '/dev/net/tun' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-string entry', () => {
    const r = stackContainerConfigSchema.safeParse({ devices: [42] });
    expect(r.success).toBe(false);
  });

  it('rejects an empty-string entry', () => {
    const r = stackContainerConfigSchema.safeParse({ devices: [''] });
    expect(r.success).toBe(false);
  });
});
