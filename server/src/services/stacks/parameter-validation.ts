import type { StackParameterDefinition, StackParameterValue } from '@mini-infra/types';
import { mergeParameterValues } from './utils';

export type ParameterIssue = {
  name: string;
  description?: string;
  error: string;
};

/**
 * Check that every parameter definition has a non-empty value (either from
 * the stored parameterValues or the definition's default). Returns the list
 * of empty parameters so callers can build the appropriate response shape
 * (the /validate and /apply endpoints expose this differently).
 */
export function findEmptyStackParameters(
  parameters: unknown,
  parameterValues: unknown,
): ParameterIssue[] {
  const paramDefs = (parameters as StackParameterDefinition[] | null | undefined) ?? [];
  const values = mergeParameterValues(
    paramDefs,
    (parameterValues as Record<string, StackParameterValue> | null | undefined) ?? {},
  );

  return paramDefs
    .filter((def) => {
      const value = values[def.name];
      return value === '' || value === undefined || value === null;
    })
    .map((def) => ({
      name: def.name,
      description: def.description,
      error: 'Parameter is required but has no value',
    }));
}
