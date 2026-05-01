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
  /** Defined input names for `{{inputs.X}}` lookup (only valid in vault.kv[].path). */
  inputNames?: Set<string>;
  /** All template fields that may contain `{{...}}`. Walks recursively. */
  services: unknown;
  configFiles: unknown;
  networks: unknown;
  volumes: unknown;
  resourceInputs: unknown;
  resourceOutputs: unknown;
  /** Vault section — policy names, appRole names, and KV paths support substitution. */
  vaultPolicies?: unknown;
  vaultAppRoles?: unknown;
  vaultKvPaths?: string[];
  /** NATS section — subjectPrefix, role pub/sub patterns, signer scopes, exports, and import subjects support substitution. */
  natsSubjectPrefix?: string;
  natsRoles?: unknown;
  natsSigners?: unknown;
  natsExports?: unknown;
  natsImports?: unknown;
}

export function validateTemplateSubstitutions(input: ValidateInput): TemplateSubstitutionIssue[] {
  const issues: TemplateSubstitutionIssue[] = [];
  const ctx: WalkContext = {
    scope: input.scope,
    parameterNames: input.parameterNames,
    inputNames: input.inputNames ?? new Set(),
    inputsContext: false,
    issues,
  };
  walk(input.services, 'services', ctx);
  walk(input.configFiles, 'configFiles', ctx);
  walk(input.networks, 'networks', ctx);
  walk(input.volumes, 'volumes', ctx);
  walk(input.resourceInputs, 'resourceInputs', ctx);
  walk(input.resourceOutputs, 'resourceOutputs', ctx);

  // Vault policy names and bodies — {{stack.id}}, {{environment.*}}, {{params.*}} allowed
  if (input.vaultPolicies) {
    walk(input.vaultPolicies, 'vault.policies', ctx);
  }
  // Vault appRole names — same set of allowed namespaces
  if (input.vaultAppRoles) {
    walk(input.vaultAppRoles, 'vault.appRoles', ctx);
  }
  // KV paths only — {{inputs.*}} additionally allowed here
  if (input.vaultKvPaths) {
    const kvCtx: WalkContext = { ...ctx, inputsContext: true };
    for (let i = 0; i < input.vaultKvPaths.length; i++) {
      walk(input.vaultKvPaths[i], `vault.kv[${i}].path`, kvCtx);
    }
  }

  // NATS section — params/stack/environment substitutions allowed in
  // subjectPrefix, role pub/sub patterns, signer scopes, export subjects,
  // and import subjects. Same allowed namespaces as the Vault section
  // (no `{{inputs.*}}` — that namespace is KV-only).
  if (input.natsSubjectPrefix !== undefined) {
    walk(input.natsSubjectPrefix, 'nats.subjectPrefix', ctx);
  }
  if (input.natsRoles) {
    walk(input.natsRoles, 'nats.roles', ctx);
  }
  if (input.natsSigners) {
    walk(input.natsSigners, 'nats.signers', ctx);
  }
  if (input.natsExports) {
    walk(input.natsExports, 'nats.exports', ctx);
  }
  if (input.natsImports) {
    walk(input.natsImports, 'nats.imports', ctx);
  }

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
  inputNames: Set<string>;
  /** True when walking a context where {{inputs.*}} is valid (KV paths only). */
  inputsContext: boolean;
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
        message: `'${token}' is missing a namespace — expected one of params|stack|environment${ctx.inputsContext ? '|inputs' : ''}`,
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
      case 'inputs':
        if (!ctx.inputsContext) {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' uses the 'inputs' namespace which is only valid inside vault.kv[].path — use the structured fromInput: form elsewhere`,
          });
          break;
        }
        if (!ctx.inputNames.has(key)) {
          ctx.issues.push({
            path,
            token,
            message: `'${token}' references unknown input '${key}' (defined inputs: ${formatList(ctx.inputNames)})`,
          });
        }
        break;
      default:
        ctx.issues.push({
          path,
          token,
          message: `'${token}' uses unknown namespace '${namespace}' (allowed: params, stack, environment${ctx.inputsContext ? ', inputs' : ''})`,
        });
    }
  }
}

function formatList(set: Set<string>): string {
  if (set.size === 0) return 'none defined';
  return Array.from(set).map((n) => `'${n}'`).join(', ');
}
