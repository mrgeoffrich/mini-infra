import { describe, it, expect } from 'vitest';
import { stackContainerConfigSchema } from '../services/stacks/schemas';

// Roundtrip the dynamicEnv shape through the container-config schema. Using
// the public schema keeps coverage on the discriminated union plus the
// envelope (env/dynamicEnv overlap check, etc.).
function parseDyn(dynamicEnv: Record<string, unknown>) {
  return stackContainerConfigSchema.safeParse({ dynamicEnv });
}

describe('dynamicEnvSource — discriminated union', () => {
  it('accepts vault-addr', () => {
    expect(parseDyn({ A: { kind: 'vault-addr' } }).success).toBe(true);
  });

  it('accepts vault-role-id', () => {
    expect(parseDyn({ A: { kind: 'vault-role-id' } }).success).toBe(true);
  });

  it('accepts vault-wrapped-secret-id with optional ttlSeconds', () => {
    expect(parseDyn({ A: { kind: 'vault-wrapped-secret-id' } }).success).toBe(true);
    expect(parseDyn({ A: { kind: 'vault-wrapped-secret-id', ttlSeconds: 600 } }).success).toBe(true);
  });

  it('accepts pool-management-token referencing a service name', () => {
    expect(parseDyn({ A: { kind: 'pool-management-token', poolService: 'worker' } }).success).toBe(true);
  });
});

describe('dynamicEnvSource — vault-kv (new in Phase 1)', () => {
  it('accepts a well-formed vault-kv entry', () => {
    expect(
      parseDyn({ SLACK_BOT_TOKEN: { kind: 'vault-kv', path: 'shared/slack', field: 'bot_token' } }).success,
    ).toBe(true);
  });

  it('accepts deeply nested paths', () => {
    expect(
      parseDyn({ K: { kind: 'vault-kv', path: 'users/alice_42/api-keys', field: 'primary' } }).success,
    ).toBe(true);
  });

  it('rejects empty path', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: '', field: 'f' } }).success).toBe(false);
  });

  it('rejects leading slash', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: '/shared/slack', field: 'f' } }).success).toBe(false);
  });

  it('rejects trailing slash', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/slack/', field: 'f' } }).success).toBe(false);
  });

  it('rejects path containing ..', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/../etc', field: 'f' } }).success).toBe(false);
  });

  it('rejects path containing //', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared//slack', field: 'f' } }).success).toBe(false);
  });

  it('rejects characters outside the allowlist in the path', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/sl ack', field: 'f' } }).success).toBe(false);
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/slack:bot', field: 'f' } }).success).toBe(false);
  });

  it('rejects empty field name', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/slack', field: '' } }).success).toBe(false);
  });

  it('rejects characters outside the allowlist in the field', () => {
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/slack', field: 'bot.token' } }).success).toBe(false);
    expect(parseDyn({ K: { kind: 'vault-kv', path: 'shared/slack', field: 'bot/token' } }).success).toBe(false);
  });

  it('rejects unknown discriminant', () => {
    expect(parseDyn({ K: { kind: 'vault-something-else', path: 'x', field: 'y' } }).success).toBe(false);
  });
});

describe('stackContainerConfigSchema — wrapped-secret-id + restartPolicy guard', () => {
  // Single-use credentials must not be paired with a restart policy that
  // retries forever. Auto-restart after first unwrap floods logs with
  // "wrapping token is not valid" and buries the original first-boot error.
  // Customer feedback #3 from the slackbot installer review.

  function parseFull(restartPolicy: string | undefined, kind = 'vault-wrapped-secret-id') {
    return stackContainerConfigSchema.safeParse({
      dynamicEnv: { TOKEN: kind === 'vault-wrapped-secret-id' ? { kind } : { kind, path: 'x', field: 'y' } },
      ...(restartPolicy === undefined ? {} : { restartPolicy }),
    });
  }

  it('rejects wrapped-secret-id with restartPolicy="always"', () => {
    const r = parseFull('always');
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('wrapped') && m.includes('always'))).toBe(true);
      expect(messages.some((m) => m.includes('TOKEN'))).toBe(true);
    }
  });

  it('rejects wrapped-secret-id with restartPolicy="unless-stopped"', () => {
    const r = parseFull('unless-stopped');
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('unless-stopped'))).toBe(true);
    }
  });

  it('accepts wrapped-secret-id with restartPolicy="no"', () => {
    expect(parseFull('no').success).toBe(true);
  });

  it('accepts wrapped-secret-id with restartPolicy="on-failure"', () => {
    expect(parseFull('on-failure').success).toBe(true);
  });

  it('accepts wrapped-secret-id with restartPolicy unset (Docker default = no)', () => {
    expect(parseFull(undefined).success).toBe(true);
  });

  it('does not block restartPolicy="always" when no wrapped-secret-id is present', () => {
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { ROLE_ID: { kind: 'vault-role-id' } },
      restartPolicy: 'always',
    });
    expect(r.success).toBe(true);
  });

  it('reports every wrapped key when multiple dynamicEnv entries use the same kind', () => {
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: {
        TOKEN_A: { kind: 'vault-wrapped-secret-id' },
        TOKEN_B: { kind: 'vault-wrapped-secret-id', ttlSeconds: 600 },
      },
      restartPolicy: 'always',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('TOKEN_A') && m.includes('TOKEN_B'))).toBe(true);
    }
  });
});
