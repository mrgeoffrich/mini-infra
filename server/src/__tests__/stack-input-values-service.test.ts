/**
 * Unit tests for stack-input-values-service.ts
 *
 * Covers:
 *   - encrypt/decrypt round-trip
 *   - mergeForUpgrade: silent reuse of existing values
 *   - mergeForUpgrade: supplied value overrides stored
 *   - mergeForUpgrade: throws InputValuesMissingError for rotateOnUpgrade=true
 *     inputs that are absent from the supplied map
 *   - mergeForUpgrade: omits keys not in declarations
 *   - Decrypt failure on tampered ciphertext
 */

import { describe, it, expect } from 'vitest';
import {
  encryptInputValues,
  decryptInputValues,
  mergeForUpgrade,
  InputValuesMissingError,
} from '../services/stacks/stack-input-values-service';
import type { TemplateInputDeclaration } from '@mini-infra/types';

// setup-unit.ts sets the auth secret to "test-secret-key-for-testing-only"
// — encryptInputValues uses it via getAuthSecret().

function decl(
  name: string,
  opts: Partial<Omit<TemplateInputDeclaration, 'name'>> = {},
): TemplateInputDeclaration {
  return {
    name,
    sensitive: true,
    required: true,
    rotateOnUpgrade: false,
    ...opts,
  };
}

// ─── Encrypt / Decrypt round-trip ────────────────────────────────────────────

describe('encryptInputValues / decryptInputValues', () => {
  it('round-trips a single key-value pair', () => {
    const values = { botToken: 'xoxb-1234' };
    const blob = encryptInputValues(values);
    const decrypted = decryptInputValues(blob);
    expect(decrypted).toEqual(values);
  });

  it('round-trips multiple key-value pairs', () => {
    const values = {
      botToken: 'xoxb-1234',
      appToken: 'xapp-5678',
      webhookSecret: 'wh-super-secret',
    };
    const blob = encryptInputValues(values);
    const decrypted = decryptInputValues(blob);
    expect(decrypted).toEqual(values);
  });

  it('round-trips an empty map', () => {
    const blob = encryptInputValues({});
    expect(decryptInputValues(blob)).toEqual({});
  });

  it('produces different ciphertext each call (random nonce)', () => {
    const values = { k: 'v' };
    const blob1 = encryptInputValues(values);
    const blob2 = encryptInputValues(values);
    // Both decrypt to the same plaintext but must differ (random nonce)
    expect(blob1).not.toBe(blob2);
    expect(decryptInputValues(blob1)).toEqual(values);
    expect(decryptInputValues(blob2)).toEqual(values);
  });

  it('returns a non-empty base64 string', () => {
    const blob = encryptInputValues({ a: 'b' });
    expect(typeof blob).toBe('string');
    expect(blob.length).toBeGreaterThan(0);
    // Should be valid base64 — decoding shouldn't throw
    expect(() => Buffer.from(blob, 'base64')).not.toThrow();
  });

  it('throws on a tampered (truncated) ciphertext', () => {
    const blob = encryptInputValues({ k: 'v' });
    // Corrupt by trimming bytes from the base64 payload
    const buf = Buffer.from(blob, 'base64');
    const truncated = buf.subarray(0, Math.max(0, buf.length - 10)).toString('base64');
    expect(() => decryptInputValues(truncated)).toThrow();
  });

  it('throws on a completely invalid ciphertext', () => {
    expect(() => decryptInputValues('not-a-real-ciphertext')).toThrow();
  });
});

// ─── mergeForUpgrade ─────────────────────────────────────────────────────────

describe('mergeForUpgrade', () => {
  it('silently reuses stored values when supplied does not include them', () => {
    const stored = { botToken: 'xoxb-stored', appToken: 'xapp-stored' };
    const supplied = {};
    const decls = [decl('botToken'), decl('appToken')];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged).toEqual({ botToken: 'xoxb-stored', appToken: 'xapp-stored' });
  });

  it('overrides stored value with supplied value', () => {
    const stored = { botToken: 'xoxb-old' };
    const supplied = { botToken: 'xoxb-new' };
    const decls = [decl('botToken')];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged).toEqual({ botToken: 'xoxb-new' });
  });

  it('includes only declared inputs in the result', () => {
    const stored = { botToken: 'xoxb-1', undeclared: 'should-be-dropped' };
    const supplied = { alsoUndeclared: 'ignored' };
    const decls = [decl('botToken')];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged).toEqual({ botToken: 'xoxb-1' });
    expect(Object.keys(merged)).not.toContain('undeclared');
    expect(Object.keys(merged)).not.toContain('alsoUndeclared');
  });

  it('omits an optional input that has no stored or supplied value', () => {
    const stored = {};
    const supplied = {};
    const decls = [decl('optionalKey', { required: false })];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(Object.keys(merged)).toHaveLength(0);
  });

  it('returns an empty object when no declarations are provided', () => {
    const merged = mergeForUpgrade({ k: 'v' }, { k: 'v2' }, []);
    expect(merged).toEqual({});
  });

  // rotateOnUpgrade tests

  it('throws InputValuesMissingError for rotateOnUpgrade=true when not in supplied', () => {
    const stored = { appToken: 'xapp-old' };
    const supplied = {};
    const decls = [decl('appToken', { rotateOnUpgrade: true })];

    expect(() => mergeForUpgrade(stored, supplied, decls)).toThrow(InputValuesMissingError);
  });

  it('InputValuesMissingError reports the input name', () => {
    const decls = [decl('secretWebhook', { rotateOnUpgrade: true })];

    try {
      mergeForUpgrade({}, {}, decls);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InputValuesMissingError);
      expect((err as InputValuesMissingError).inputName).toBe('secretWebhook');
      expect((err as InputValuesMissingError).message).toMatch(/secretWebhook/);
    }
  });

  it('accepts rotateOnUpgrade=true when the value is in supplied', () => {
    const stored = { appToken: 'xapp-old' };
    const supplied = { appToken: 'xapp-rotated' };
    const decls = [decl('appToken', { rotateOnUpgrade: true })];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged).toEqual({ appToken: 'xapp-rotated' });
  });

  it('uses supplied over stored for rotateOnUpgrade=true', () => {
    const stored = { token: 'old' };
    const supplied = { token: 'new' };
    const decls = [decl('token', { rotateOnUpgrade: true })];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged.token).toBe('new');
  });

  it('handles mixed declarations correctly', () => {
    const stored = { normal: 'stored-normal', rotated: 'old-rotated' };
    const supplied = { rotated: 'new-rotated' };
    const decls = [
      decl('normal'),
      decl('rotated', { rotateOnUpgrade: true }),
    ];

    const merged = mergeForUpgrade(stored, supplied, decls);
    expect(merged.normal).toBe('stored-normal');
    expect(merged.rotated).toBe('new-rotated');
  });

  it('throws on the first missing rotateOnUpgrade input', () => {
    const decls = [
      decl('a', { rotateOnUpgrade: true }),
      decl('b', { rotateOnUpgrade: true }),
    ];

    // Both missing; should throw on 'a' (first)
    expect(() => mergeForUpgrade({}, {}, decls)).toThrow(InputValuesMissingError);
  });
});
