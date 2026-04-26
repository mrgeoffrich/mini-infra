import { describe, it, expect } from 'vitest';
import {
  validateKvPath,
  validateKvFieldName,
  VaultKVError,
  KV_MOUNT,
} from '../services/vault/vault-kv-paths';

describe('validateKvPath', () => {
  it('accepts a simple path', () => {
    expect(validateKvPath('shared/slack')).toBe('shared/slack');
  });

  it('accepts deeply nested paths with hyphens, underscores, and digits', () => {
    expect(validateKvPath('users/alice_42-prod/api-keys')).toBe('users/alice_42-prod/api-keys');
  });

  it('rejects empty strings', () => {
    expect(() => validateKvPath('')).toThrow(VaultKVError);
  });

  it('rejects paths starting with /', () => {
    expect(() => validateKvPath('/shared/slack')).toThrow(/must not start with/);
  });

  it('rejects paths ending with /', () => {
    expect(() => validateKvPath('shared/slack/')).toThrow(/must not end with/);
  });

  it('rejects paths containing ..', () => {
    expect(() => validateKvPath('shared/../etc/passwd')).toThrow(/must not contain '\.\.'/);
  });

  it('rejects paths containing //', () => {
    expect(() => validateKvPath('shared//slack')).toThrow(/must not contain/);
  });

  it('rejects characters outside the allowlist (no spaces, colons, etc)', () => {
    expect(() => validateKvPath('shared/slack:bot')).toThrow(/letters, numbers/);
    expect(() => validateKvPath('shared/sl ack')).toThrow(/letters, numbers/);
    expect(() => validateKvPath('shared/slack@v1')).toThrow(/letters, numbers/);
  });

  it('rejects oversize paths', () => {
    expect(() => validateKvPath('a'.repeat(257))).toThrow(/exceeds 256/);
  });

  it('attaches code "invalid_path" to the error', () => {
    try {
      validateKvPath('/bad');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultKVError);
      expect((err as VaultKVError).code).toBe('invalid_path');
    }
  });
});

describe('validateKvFieldName', () => {
  it('accepts simple identifiers', () => {
    expect(validateKvFieldName('bot_token')).toBe('bot_token');
    expect(validateKvFieldName('apiKey')).toBe('apiKey');
    expect(validateKvFieldName('value-1')).toBe('value-1');
  });

  it('rejects empty strings', () => {
    expect(() => validateKvFieldName('')).toThrow(VaultKVError);
  });

  it('rejects characters outside the allowlist', () => {
    expect(() => validateKvFieldName('bot.token')).toThrow(/letters, numbers/);
    expect(() => validateKvFieldName('bot/token')).toThrow(/letters, numbers/);
    expect(() => validateKvFieldName('bot token')).toThrow(/letters, numbers/);
  });
});

describe('KV_MOUNT', () => {
  it('is "secret" — the default KV v2 mount Mini Infra bootstraps', () => {
    // The dynamicEnv resolver, the route broker, and the seed all rely on
    // this constant. Changing the mount means coordinated changes elsewhere
    // (operator policy, bootstrap, seed) — flag if it ever drifts.
    expect(KV_MOUNT).toBe('secret');
  });
});
