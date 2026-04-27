/**
 * Regression test: serializeStack() must never leak encryptedInputValues.
 *
 * Covers:
 *   - encryptedInputValues is stripped from output for every call site (CRITICAL)
 *   - inputValueKeys contains the stored input names when values are present
 *   - inputValueKeys is absent (not []) when no values are stored
 *   - inputValueKeys is [] when the ciphertext cannot be decrypted
 */

import { describe, it, expect } from 'vitest';
import { encryptInputValues } from '../../services/stacks/stack-input-values-service';
import { serializeStack } from '../../services/stacks/utils';

function makeStack(overrides: Record<string, unknown> = {}): Parameters<typeof serializeStack>[0] {
  return {
    id: 'stack-1',
    name: 'test',
    description: null,
    environmentId: null,
    version: 1,
    status: 'undeployed',
    lastAppliedVersion: null,
    lastAppliedAt: null,
    lastAppliedSnapshot: null,
    builtinVersion: null,
    templateId: null,
    templateVersion: null,
    parameters: [],
    parameterValues: {},
    resourceOutputs: [],
    resourceInputs: [],
    networks: [],
    volumes: [],
    tlsCertificates: [],
    dnsRecords: [],
    tunnelIngress: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    services: [],
    ...overrides,
  };
}

describe('serializeStack — field stripping and inclusion', () => {
  it('strips lastAppliedVaultSnapshot from output', () => {
    const snapshot = { policies: { hashes: {} }, appRoles: { hashes: {} }, kv: { hashes: { 'smoke/cma23xx': 'abc123' } } };
    const result = serializeStack(makeStack({ lastAppliedVaultSnapshot: snapshot }));

    expect((result as Record<string, unknown>)['lastAppliedVaultSnapshot']).toBeUndefined();
  });

  it('includes lastFailureReason in output when set', () => {
    const result = serializeStack(makeStack({ lastFailureReason: 'KV path validation failed for smoke/cma23xx' }));

    expect((result as Record<string, unknown>)['lastFailureReason']).toBe('KV path validation failed for smoke/cma23xx');
  });

  it('includes lastFailureReason: null when cleared', () => {
    const result = serializeStack(makeStack({ lastFailureReason: null }));

    expect((result as Record<string, unknown>)['lastFailureReason']).toBeNull();
  });
});

describe('serializeStack — encryptedInputValues handling', () => {
  it('strips encryptedInputValues when present', () => {
    const blob = encryptInputValues({ token: 'secret-value' });
    const result = serializeStack(makeStack({ encryptedInputValues: blob }));

    expect((result as Record<string, unknown>)['encryptedInputValues']).toBeUndefined();
  });

  it('populates inputValueKeys with the stored input names', () => {
    const blob = encryptInputValues({ apiKey: 'abc', token: 'xyz' });
    const result = serializeStack(makeStack({ encryptedInputValues: blob }));

    expect(result.inputValueKeys).toBeDefined();
    expect(result.inputValueKeys).toHaveLength(2);
    expect(result.inputValueKeys).toContain('apiKey');
    expect(result.inputValueKeys).toContain('token');
  });

  it('omits inputValueKeys entirely when no encrypted values are stored', () => {
    const result = serializeStack(makeStack({ encryptedInputValues: null }));

    expect((result as Record<string, unknown>)['inputValueKeys']).toBeUndefined();
  });

  it('returns inputValueKeys as [] when ciphertext is corrupt (graceful degradation)', () => {
    const result = serializeStack(makeStack({ encryptedInputValues: 'fake-ciphertext' }));

    expect((result as Record<string, unknown>)['encryptedInputValues']).toBeUndefined();
    expect(result.inputValueKeys).toEqual([]);
  });

  it('does not return inputValueKeys when encryptedInputValues field is absent', () => {
    const result = serializeStack(makeStack());

    expect((result as Record<string, unknown>)['inputValueKeys']).toBeUndefined();
  });

  it('still serialises dates correctly alongside the stripping', () => {
    const blob = encryptInputValues({ k: 'v' });
    const stack = makeStack({
      encryptedInputValues: blob,
      createdAt: new Date('2024-06-15T12:00:00Z'),
      updatedAt: new Date('2024-06-15T13:00:00Z'),
    });
    const result = serializeStack(stack);

    expect(result.createdAt).toBe('2024-06-15T12:00:00.000Z');
    expect(result.updatedAt).toBe('2024-06-15T13:00:00.000Z');
    expect((result as Record<string, unknown>)['encryptedInputValues']).toBeUndefined();
  });
});
