/**
 * Pre-publish validator for `{{...}}` template substitutions.
 *
 * Catches authoring typos at publish time instead of letting them surface
 * as "Unresolved template variable" errors during apply (which can be
 * minutes after the user clicked publish, with the apply potentially
 * blocking other work). Also enforces the host-vs-environment scope
 * invariants: `{{environment.*}}` is meaningless on a host-scoped template.
 *
 * Pure — no DB access, no logger. Walks the input tree once, collects every
 * issue, and returns them all so the user sees one shot of feedback rather
 * than fixing-and-retrying one error at a time.
 */

import type { StackParameterDefinition } from '@mini-infra/types';

const ALLOWED_STACK_KEYS = ['id', 'name', 'projectName'] as const;
const ALLOWED_ENVIRONMENT_KEYS = ['id', 'name', 'type', 'networkType'] as const;
const SUBSTITUTION_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export interface TemplateSubstitutionIssue {
  /** JSON-pointer-style location of the offending value, e.g. `services[2].containerConfig.env.SLACK_TOKEN`. */
  path: string;
  /** The raw substitution token, e.g. `{{stak.id}}`. */
  token: string;
  /** Why it was rejected. Operator-friendly. */
  message: string;
}

export interface ValidateInput {
  /** Template `scope` — `'host'` blocks `{{environment.*}}` references. */
  scope: 'host' | 'environment' | 'any' | string;
  /** Defined parameter names (from the draft) for `{{params.X}}` lookup. */
  parameterNames: Set<string>;
  /** All template fields that may contain `{{...}}`. Walks recursively. */
  services: unknown;
  configFiles: unknown;
  networks: unknown;
  volumes: unknown;
  resourceInputs: unknown;
  resourceOutputs: unknown;
}

export function validateTemplateSubstitutions(input: ValidateInput): TemplateSubstitutionIssue[] {
  const issues: TemplateSubstitutionIssue[] = [];
  const ctx = {
    scope: input.scope,
    parameterNames: input.parameterNames,
    issues,
  };
  walk(input.services, 'services', ctx);
  walk(input.configFiles, 'configFiles', ctx);
  walk(input.networks, 'networks', ctx);
  walk(input.volumes, 'volumes', ctx);
  walk(input.resourceInputs, 'resourceInputs', ctx);
  walk(input.resourceOutputs, 'resourceOutputs', ctx);
  return issues;
}

/** Convenience for `(parameters: StackParameterDefinition[]) => Set<string>`. */
export function parameterNamesFromDefinitions(
  parameters: StackParameterDefinition[] | undefined,
): Set<string> {
  return new Set((parameters ?? []).map((p) => p.name));
}

interface WalkContext {
  scope: string;
  parameterNames: Set<string>;
  issues: TemplateSubstitutionIssue[];
}

function walk(node: unknown, path: string, ctx: WalkContext): void {
  if (typeof node === 'string') {
    checkString(node, path, ctx);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, ctx);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, ctx);
    }
  }
}

function checkString(value: string, path: string, ctx: WalkContext): void {
  if (!value.includes('{{')) return;
  // Reset regex state — `g` flag preserves lastIndex between calls.
  SUBSTITUTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SUBSTITUTION_PATTERN.exec(value)) !== null) {
    const token = match[0];
    const inner = match[1].trim();
    const dot = inner.indexOf('.');
    if (dot < 0) {
      ctx.issues.push({
        path,
        token,
        message: `'${token}' is missing a namespace — expected one of params|stack|environment`,
      });
      continue;
    }
    const namespace = inner.slice(0, dot);
    const key = inner.slice(dot + 1);
    switch (namespace) {
      case 'params':
        if (!ctx.parameterNames.has(key)) {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' references unknown parameter '${key}' (defined parameters: ${formatList(ctx.parameterNames)})`,
          });
        }
        break;
      case 'stack':
        if (!ALLOWED_STACK_KEYS.includes(key as typeof ALLOWED_STACK_KEYS[number])) {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' references unknown stack key '${key}' (allowed: ${ALLOWED_STACK_KEYS.join(', ')})`,
          });
        }
        break;
      case 'environment':
        if (ctx.scope === 'host') {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' references the environment namespace, but this template is host-scoped (templates only see environment metadata when scope='environment' or 'any')`,
          });
          break;
        }
        if (!ALLOWED_ENVIRONMENT_KEYS.includes(key as typeof ALLOWED_ENVIRONMENT_KEYS[number])) {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' references unknown environment key '${key}' (allowed: ${ALLOWED_ENVIRONMENT_KEYS.join(', ')})`,
          });
        }
        break;
      default:
        ctx.issues.push({
          path,
          token,
          message: `'${token}' uses unknown namespace '${namespace}' (allowed: params, stack, environment)`,
        });
    }
  }
}

function formatList(set: Set<string>): string {
  if (set.size === 0) return 'none defined';
  return Array.from(set).map((n) => `'${n}'`).join(', ');
}
