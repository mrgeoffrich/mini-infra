import { describe, it, expect } from 'vitest';
import { findEmptyStackParameters } from '../parameter-validation';

describe('findEmptyStackParameters', () => {
  it('returns [] when there are no parameter definitions', () => {
    expect(findEmptyStackParameters(null, null)).toEqual([]);
    expect(findEmptyStackParameters(undefined, undefined)).toEqual([]);
    expect(findEmptyStackParameters([], {})).toEqual([]);
  });

  it('flags parameters with empty-string values', () => {
    const paramDefs = [{ name: 'host', description: 'DB host' }];
    const values = { host: '' };
    expect(findEmptyStackParameters(paramDefs, values)).toEqual([
      { name: 'host', description: 'DB host', error: expect.any(String) },
    ]);
  });

  it('flags parameters with undefined values', () => {
    const paramDefs = [{ name: 'host', description: 'DB host' }];
    expect(findEmptyStackParameters(paramDefs, {})).toEqual([
      { name: 'host', description: 'DB host', error: expect.any(String) },
    ]);
  });

  it('flags parameters with explicit null', () => {
    const paramDefs = [{ name: 'host', description: 'DB host' }];
    const values = { host: null };
    expect(findEmptyStackParameters(paramDefs, values)).toEqual([
      { name: 'host', description: 'DB host', error: expect.any(String) },
    ]);
  });

  it('accepts parameters with non-empty values', () => {
    const paramDefs = [{ name: 'host', description: 'DB host' }];
    const values = { host: 'db.local' };
    expect(findEmptyStackParameters(paramDefs, values)).toEqual([]);
  });

  it('uses defaults from the definition when no value is supplied', () => {
    const paramDefs = [{ name: 'port', description: 'Port', default: '5432' }];
    expect(findEmptyStackParameters(paramDefs, {})).toEqual([]);
  });

  it('returns multiple issues when several parameters are empty', () => {
    const paramDefs = [
      { name: 'host', description: 'DB host' },
      { name: 'port', description: 'DB port' },
      { name: 'db', description: 'DB name' },
    ];
    const values = { host: 'db.local', port: '', db: undefined };
    const result = findEmptyStackParameters(paramDefs, values);
    expect(result.map((r) => r.name).sort()).toEqual(['db', 'port']);
  });
});
