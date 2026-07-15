/**
 * Stack template export / import codec.
 *
 * Exporting a template version produces a portable YAML document; importing one
 * on another Mini Infra instance recreates it as a *user* template. This module
 * is the pure core of both directions — dependency-free (the YAML parser lives
 * with the caller, same rule as `compose-import.ts`), so the server export/import
 * routes and any future client-side use share one implementation.
 *
 * Two things make export/import more than a straight round-trip:
 *
 *  1. **Secrets don't travel.** A template can embed literal Vault KV values
 *     (`vault.kv[].fields[].value`). An export file is a shareable artifact —
 *     it can land in a git repo or a chat — so those literals are redacted and
 *     the removal is reported, never silent. `{ fromInput }` references carry no
 *     secret and are kept as-is.
 *
 *  2. **Some things are keyed to the origin instance.** A custom NATS subject
 *     prefix is gated by an admin allowlist keyed by *template ID*; the import
 *     mints a brand-new ID, so the claim can't follow the file. Rather than fail
 *     mysteriously at first deploy, the import surfaces it as an issue up front.
 *
 * Everything not carried across is reported through the shared `ImportIssue`
 * model, exactly like the Compose importer.
 */
import type { ImportIssue } from './import-issues';
import type { EnvironmentNetworkType } from './environments';
import type {
  CreateStackTemplateRequest,
  DraftVersionInput,
  StackTemplateScope,
  StackTemplateVersionInfo,
  TemplateKvFieldValue,
  TemplateVaultKv,
  TemplateVaultSection,
} from './stack-templates';
import { buildDraftFromVersion } from './template-draft';
import { DEFAULT_NATS_SUBJECT_PREFIX_TEMPLATE } from './nats-subjects';

/** Current export-document format tag. Bump the version suffix on a breaking change. */
export const TEMPLATE_EXPORT_FORMAT = 'mini-infra.stack-template/v1' as const;

/** Prefix every recognised format shares — used to give a targeted error on a foreign file. */
const TEMPLATE_EXPORT_FORMAT_PREFIX = 'mini-infra.stack-template/';

/**
 * Replaces a redacted literal secret in an export file. Distinctive on purpose:
 * the importer detects it and tells the user which fields still need a real
 * value before the template can deploy.
 */
export const REDACTED_SECRET_PLACEHOLDER = '__mini-infra:redacted-secret__';

/** Template envelope — the `StackTemplate`-level metadata a version doesn't carry. */
export interface TemplateExportEnvelope {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  scope: StackTemplateScope;
  networkType?: EnvironmentNetworkType;
}

/** The exported document. `version` is the lossless authoring body of one version. */
export interface TemplateExportDocument {
  format: typeof TEMPLATE_EXPORT_FORMAT;
  /** Informational; ignored on import. Stamped by the caller so this stays pure. */
  exportedAt?: string;
  /** Which version number this was exported from. Informational; ignored on import. */
  sourceVersion?: number;
  template: TemplateExportEnvelope;
  version: DraftVersionInput;
}

export interface TemplateExportResult {
  document: TemplateExportDocument;
  /** Redaction (and any other build-time) notices. */
  issues: ImportIssue[];
}

export interface TemplateImportResult {
  /** False when at least one blocking (`error`) issue was raised — `request` is then null. */
  ok: boolean;
  request: CreateStackTemplateRequest | null;
  issues: ImportIssue[];
  /** The template name from the file, surfaced even when ok=false for the UI. */
  templateName?: string;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isLiteralValue(field: TemplateKvFieldValue): field is { value: string } {
  return typeof (field as { value?: unknown }).value === 'string';
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Redact literal Vault KV secrets, collecting a `lossy` issue per field removed.
 * Returns a new section; the input is not mutated. `{ fromInput }` refs pass
 * through untouched (they name an install-time input, not a secret).
 */
function redactVaultSecrets(
  vault: TemplateVaultSection,
  issues: ImportIssue[],
): TemplateVaultSection {
  if (!vault.kv || vault.kv.length === 0) return vault;

  const kv: TemplateVaultKv[] = vault.kv.map((entry) => {
    const fields: Record<string, TemplateKvFieldValue> = {};
    for (const [name, field] of Object.entries(entry.fields)) {
      if (isLiteralValue(field)) {
        fields[name] = { value: REDACTED_SECRET_PLACEHOLDER };
        issues.push({
          level: 'lossy',
          path: `version.vault.kv[${entry.path}].fields.${name}`,
          message:
            'A literal secret value was removed from the export. Set it again after import (or switch it to a `fromInput` reference) before deploying.',
        });
      } else {
        fields[name] = field;
      }
    }
    return { ...entry, fields };
  });

  return { ...vault, kv };
}

/**
 * Build a portable export document from a stored template version plus its
 * envelope metadata. `exportedAt` is passed in (not read from a clock) to keep
 * this function pure and its output deterministic under test.
 */
export function buildTemplateExportDocument(args: {
  template: TemplateExportEnvelope;
  version: StackTemplateVersionInfo;
  exportedAt?: string;
}): TemplateExportResult {
  const issues: ImportIssue[] = [];
  const body = buildDraftFromVersion(args.version);

  const version: DraftVersionInput = body.vault
    ? { ...body, vault: redactVaultSecrets(body.vault, issues) }
    : body;

  const document: TemplateExportDocument = {
    format: TEMPLATE_EXPORT_FORMAT,
    ...(args.exportedAt ? { exportedAt: args.exportedAt } : {}),
    sourceVersion: args.version.version,
    template: args.template,
    version,
  };

  return { document, issues };
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

/** Report every redaction placeholder left in the file so the user knows what to refill. */
function detectRedactedSecrets(version: Dict, issues: ImportIssue[]): void {
  const vault = version.vault;
  if (!isDict(vault)) return;
  const kv = vault.kv;
  if (!Array.isArray(kv)) return;
  for (const entry of kv) {
    if (!isDict(entry) || !isDict(entry.fields)) continue;
    const path = typeof entry.path === 'string' ? entry.path : '?';
    for (const [name, field] of Object.entries(entry.fields as Dict)) {
      if (isDict(field) && field.value === REDACTED_SECRET_PLACEHOLDER) {
        issues.push({
          level: 'lossy',
          path: `version.vault.kv[${path}].fields.${name}`,
          message:
            'This secret was redacted when the template was exported. Set a real value in the Code view before deploying, or the deploy will write a placeholder.',
        });
      }
    }
  }
}

/** Copy `key` from `src` onto `dst` only when it is present and non-null. */
function passThrough(src: Dict, dst: Dict, key: string): void {
  if (key in src && src[key] != null) dst[key] = src[key];
}

/**
 * Map a parsed export document into a `CreateStackTemplateRequest`. The caller
 * (server route) parses the YAML text and then runs the result through the same
 * `createTemplateSchema` Zod validation as a normal create, so this function's
 * job is envelope validation, the source-instance-specific caveats, and shaping
 * — not deep field validation.
 *
 * The `source` field is intentionally absent from the output: `createUserTemplate`
 * hard-codes `source: "user"`, so importing a system template lands it as a user
 * template with no special handling here.
 */
export function mapTemplateImportDocument(doc: unknown): TemplateImportResult {
  const issues: ImportIssue[] = [];
  const fail = (path: string, message: string): TemplateImportResult => {
    issues.push({ level: 'error', path, message });
    return { ok: false, request: null, issues };
  };

  if (!isDict(doc)) {
    return fail('', 'The file is empty or is not a template export document.');
  }

  const format = doc.format;
  if (typeof format !== 'string' || !format.startsWith(TEMPLATE_EXPORT_FORMAT_PREFIX)) {
    return fail(
      'format',
      `This is not a Mini Infra template export (expected a "format" of "${TEMPLATE_EXPORT_FORMAT}").`,
    );
  }
  if (format !== TEMPLATE_EXPORT_FORMAT) {
    return fail(
      'format',
      `Unsupported export version "${format}". This instance understands "${TEMPLATE_EXPORT_FORMAT}" — export again from a matching version.`,
    );
  }

  const template = doc.template;
  if (!isDict(template)) {
    return fail('template', 'The export is missing its template metadata.');
  }
  const version = doc.version;
  if (!isDict(version)) {
    return fail('version', 'The export is missing its version body.');
  }

  const name = typeof template.name === 'string' ? template.name : '';
  const displayName = typeof template.displayName === 'string' ? template.displayName : '';
  if (!name) issues.push({ level: 'error', path: 'template.name', message: 'A template name is required.' });
  if (!displayName)
    issues.push({ level: 'error', path: 'template.displayName', message: 'A template display name is required.' });

  // Scope: user templates are host- or environment-scoped. A `any`-scoped system
  // template (or a missing scope) is coerced to `environment` and reported, since
  // the create schema rejects `any`.
  let scope: StackTemplateScope = 'environment';
  const rawScope = template.scope;
  if (rawScope === 'host' || rawScope === 'environment') {
    scope = rawScope;
  } else {
    issues.push({
      level: 'defaulted',
      path: 'template.scope',
      message: `Scope "${String(rawScope ?? 'unset')}" can't apply to a user template; defaulting to "environment". Adjust it after import if this should be host-scoped.`,
    });
  }

  // Custom NATS subject prefix: the allowlist is keyed by template ID and this
  // import gets a new one, so the claim can't follow. Warn, don't block.
  const nats = version.nats;
  if (isDict(nats)) {
    const subjectPrefix = nats.subjectPrefix;
    if (
      typeof subjectPrefix === 'string' &&
      subjectPrefix.length > 0 &&
      subjectPrefix !== DEFAULT_NATS_SUBJECT_PREFIX_TEMPLATE
    ) {
      issues.push({
        level: 'lossy',
        path: 'version.nats.subjectPrefix',
        message: `This template claims the custom NATS subject prefix "${subjectPrefix}". The subject-prefix allowlist is keyed by template ID, and the import creates a new template with a new ID — an admin must add the new template to the allowlist, or the first deploy will be rejected.`,
      });
    }
  }

  detectRedactedSecrets(version, issues);

  if (issues.some((i) => i.level === 'error')) {
    return { ok: false, request: null, issues, templateName: name || undefined };
  }

  // Shape the request. Arrays default to empty (createTemplateSchema requires
  // networks/volumes/services to be arrays); every other version-body section is
  // passed through when present and validated server-side by the same Zod schema
  // the normal create route uses.
  const request = {
    name,
    displayName,
    scope,
    networks: Array.isArray(version.networks) ? version.networks : [],
    volumes: Array.isArray(version.volumes) ? version.volumes : [],
    services: Array.isArray(version.services) ? version.services : [],
  } as unknown as Dict;

  if (typeof template.description === 'string') request.description = template.description;
  if (typeof template.category === 'string') request.category = template.category;
  if (typeof template.networkType === 'string') request.networkType = template.networkType;

  for (const key of [
    'parameters',
    'defaultParameterValues',
    'networkTypeDefaults',
    'resourceOutputs',
    'resourceInputs',
    'configFiles',
    'inputs',
    'vault',
    'nats',
    'requires',
  ]) {
    passThrough(version, request, key);
  }

  return {
    ok: true,
    request: request as unknown as CreateStackTemplateRequest,
    issues,
    templateName: name,
  };
}
