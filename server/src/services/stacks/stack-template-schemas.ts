import { z } from "zod";
import { ENVIRONMENT_NETWORK_TYPES } from "@mini-infra/types";
import {
  stackParameterDefinitionSchema,
  parameterValuesSchema,
  stackNetworkSchema,
  stackVolumeSchema,
  stackServiceDefinitionSchema,
  stackResourceOutputSchema,
  stackResourceInputSchema,
} from "./schemas";
import { validateKvPath, stripTemplateTokens } from "../vault/vault-kv-paths";

const nameRegex = /^[a-zA-Z0-9_-]+$/;

// =====================
// Inputs & Vault Schemas (for API request validation)
// Exported so template-file-loader.ts can compose these without drift.
// =====================

export const templateInputDeclSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Input name must start with a letter"),
  description: z.string().max(500).optional(),
  sensitive: z.boolean().default(true),
  required: z.boolean().default(true),
  rotateOnUpgrade: z.boolean().default(false),
});

export const templateVaultPolicySchema = z.object({
  name: z.string().min(1).max(100),
  body: z.string().min(1),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
  description: z.string().max(500).optional(),
});

export const templateVaultAppRoleSchema = z.object({
  name: z.string().min(1).max(100),
  policy: z.string().min(1),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
  tokenPeriod: z.string().optional(),
  tokenTtl: z.string().optional(),
  tokenMaxTtl: z.string().optional(),
  secretIdNumUses: z.number().int().min(0).optional(),
  secretIdTtl: z.string().optional(),
});

export const kvFieldValueSchema = z.union([
  z.object({ fromInput: z.string().min(1) }),
  z.object({ value: z.string() }),
]);

export const templateVaultKvSchema = z.object({
  path: z.string().min(1).superRefine((p, ctx) => {
    try {
      validateKvPath(stripTemplateTokens(p));
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Invalid KV path",
      });
    }
  }),
  fields: z.record(z.string(), kvFieldValueSchema),
});

const templateVaultSectionSchema = z.object({
  policies: z.array(templateVaultPolicySchema).optional(),
  appRoles: z.array(templateVaultAppRoleSchema).optional(),
  kv: z.array(templateVaultKvSchema).optional(),
});

const natsSubjectSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_$*>\-.]+$/);

// Subjects in app-author roles[].publish/subscribe are *relative* to the stack's
// subjectPrefix and the orchestrator prepends. Wildcards inside the relative
// path are fine; what's forbidden is breaking out of the prefix or hitting
// reserved namespaces. Static rules:
//   - cannot start with `>` or `*` (would shadow whole prefix tree)
//   - cannot start with `_INBOX.` (use inboxAuto instead)
//   - cannot start with `$SYS.` (system-account namespace)
//   - cannot contain `..` or empty tokens
//
// Exported so the file-loader path can reuse the same strict shape.
export const natsRelativeSubjectSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_*>\-.]+$/, "subject must contain only letters, numbers, '_', '-', '.', '*', '>'")
  .refine((s) => !s.startsWith(">") && !s.startsWith("*"), {
    message: "relative subject must not start with a wildcard ('>' or '*') — that would shadow the entire stack prefix",
  })
  .refine((s) => !s.startsWith("_INBOX."), {
    message: "relative subject must not target '_INBOX.>' directly — use the inboxAuto field on the role",
  })
  .refine((s) => !s.startsWith("$SYS.") && s !== "$SYS", {
    message: "relative subject must not target the '$SYS.>' system-account namespace",
  })
  .refine((s) => !s.includes("..") && !s.split(".").some((tok) => tok.length === 0), {
    message: "relative subject must not contain empty tokens ('..' or leading/trailing dots)",
  });

// Subject scope for a signer: a relative path with no wildcards (the signing
// key is constrained to `<prefix>.<scope>.>`; scope itself must be concrete).
const natsSubjectScopeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_\-.]+$/, "signer subjectScope must contain only letters, numbers, '_', '-', '.'")
  .refine((s) => !s.includes("..") && !s.split(".").some((tok) => tok.length === 0), {
    message: "signer subjectScope must not contain empty tokens ('..' or leading/trailing dots)",
  });

export const templateNatsAccountSchema = z.object({
  name: z.string().min(1).max(100),
  displayName: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
});

export const templateNatsCredentialSchema = z.object({
  name: z.string().min(1).max(100),
  account: z.string().min(1).max(100),
  displayName: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  publishAllow: z.array(natsSubjectSchema).min(1),
  subscribeAllow: z.array(natsSubjectSchema).min(1),
  ttlSeconds: z.number().int().min(0).optional(),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
});

export const templateNatsStreamSchema = z.object({
  name: z.string().min(1).max(100),
  account: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  subjects: z.array(natsSubjectSchema).min(1),
  retention: z.enum(["limits", "interest", "workqueue"]).optional(),
  storage: z.enum(["file", "memory"]).optional(),
  maxMsgs: z.number().int().nullable().optional(),
  maxBytes: z.number().int().nullable().optional(),
  maxAgeSeconds: z.number().int().nullable().optional(),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
});

export const templateNatsConsumerSchema = z.object({
  name: z.string().min(1).max(100),
  stream: z.string().min(1).max(100),
  durableName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  filterSubject: natsSubjectSchema.optional(),
  deliverPolicy: z.enum(["all", "last", "new", "by_start_sequence", "by_start_time", "last_per_subject"]).optional(),
  ackPolicy: z.enum(["none", "all", "explicit"]).optional(),
  maxDeliver: z.number().int().nullable().optional(),
  ackWaitSeconds: z.number().int().nullable().optional(),
  scope: z.enum(["host", "environment", "stack"]).default("environment"),
});

// ----- Phase 1: app-author role / signer / import surface -----

export const templateNatsRoleSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex, "role name can only contain letters, numbers, '_', '-'"),
  publish: z.array(natsRelativeSubjectSchema).optional(),
  subscribe: z.array(natsRelativeSubjectSchema).optional(),
  inboxAuto: z.enum(["both", "reply", "request", "none"]).optional(),
  ttlSeconds: z.number().int().min(0).optional(),
});

export const templateNatsSignerSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex, "signer name can only contain letters, numbers, '_', '-'"),
  subjectScope: natsSubjectScopeSchema,
  maxTtlSeconds: z.number().int().min(1).optional(),
});

export const templateNatsImportSchema = z.object({
  fromStack: z.string().min(1).max(100),
  subjects: z.array(natsRelativeSubjectSchema).min(1),
  /** Required: per-role binding only — security-critical to prevent broadcast. */
  forRoles: z.array(z.string().min(1)).min(1),
});

// Subject prefix syntax: dotted segments of [a-zA-Z0-9_-]; `{{...}}` template
// substitutions are walked separately by the substitution validator. Can't
// contain wildcards or root-level traversal; allowlist enforces the human-
// readable case (e.g. "navi") at apply time.
//
// Exported alongside `natsRelativeSubjectSchema` so the file-loader path uses
// the same strict shapes — otherwise system-template files could sneak in
// wildcards or `$SYS.*` prefixes that the HTTP draft path rejects.
export const templateNatsSubjectPrefixSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !/[>*]/.test(s), { message: "subjectPrefix must not contain wildcards" })
  .refine((s) => !s.startsWith(".") && !s.endsWith("."), {
    message: "subjectPrefix must not start or end with '.'",
  })
  .refine((s) => !s.startsWith("$SYS"), {
    message: "subjectPrefix must not target the system-account namespace",
  });

const templateNatsSectionSchema = z.object({
  // Phase 1 additions (app-author surface)
  subjectPrefix: templateNatsSubjectPrefixSchema.optional(),
  roles: z.array(templateNatsRoleSchema).optional(),
  signers: z.array(templateNatsSignerSchema).optional(),
  exports: z.array(natsRelativeSubjectSchema).optional(),
  imports: z.array(templateNatsImportSchema).optional(),

  // Existing low-level surface (system templates / advanced)
  accounts: z.array(templateNatsAccountSchema).optional(),
  credentials: z.array(templateNatsCredentialSchema).optional(),
  streams: z.array(templateNatsStreamSchema).optional(),
  consumers: z.array(templateNatsConsumerSchema).optional(),
});

const templateNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    nameRegex,
    "Template name can only contain letters, numbers, hyphens, and underscores"
  );

const configFileInputSchema = z.object({
  serviceName: z
    .string()
    .min(1)
    .max(100)
    .regex(nameRegex, "Service name can only contain letters, numbers, hyphens, and underscores"),
  fileName: z.string().min(1),
  volumeName: z.string().min(1),
  // Must be a safe absolute path — matches `stackInitCommandSchema.mountPath`.
  // Prevents `../../etc/passwd`-style escapes when a template is instantiated.
  mountPath: z
    .string()
    .min(1)
    .regex(/^\/[a-zA-Z0-9_./-]*$/, "mountPath must be a safe absolute path"),
  content: z.string(),
  permissions: z.string().optional(),
  owner: z.string().optional(),
});

// `partialRecord` — keys are validated against the environment-network-type
// enum, but it's OK for a template to set defaults for only some network types
// (or none). A plain `z.record(enum, ...)` would require every enum value.
const networkTypeDefaultsSchema = z.partialRecord(
  z.enum(ENVIRONMENT_NETWORK_TYPES),
  parameterValuesSchema,
);

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  scope: z.enum(["host", "environment"]),
  networkType: z.enum(ENVIRONMENT_NETWORK_TYPES).optional(),
  environmentId: z.string().min(1).optional(),
  category: z.string().max(100).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networkTypeDefaults: networkTypeDefaultsSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  // Drafts may be empty — the "at least one service" constraint is enforced
  // at publish time, so users can create a template and fill it in gradually.
  services: z.array(stackServiceDefinitionSchema),
  configFiles: z.array(configFileInputSchema).optional(),
  // inputs + vault accepted directly on create so installers can submit a
  // complete spec in one request rather than create → draft → publish.
  // Same shapes as draftVersionSchema; the v0 draft persists them on the
  // initial StackTemplateVersion row.
  inputs: z.array(templateInputDeclSchema).optional(),
  vault: templateVaultSectionSchema.optional(),
  nats: templateNatsSectionSchema.optional(),
}).superRefine((data, ctx) => {
  // Mirror draftVersionSchema: vaultAppRoleRef / natsCredentialRef / natsRole /
  // natsSigner must resolve, the legacy/new mixing rule applies, and role +
  // signer names must be unique. Without this, a POST /stack-templates that
  // mixes legacy `nats.credentials` with new `nats.roles` would persist on the
  // initial v0 draft and only fail later on the first /draft save.
  const appRoleNames = new Set((data.vault?.appRoles ?? []).map((a) => a.name));
  const credentialNames = new Set((data.nats?.credentials ?? []).map((c) => c.name));
  const roleNames = new Set((data.nats?.roles ?? []).map((r) => r.name));
  const signerNames = new Set((data.nats?.signers ?? []).map((s) => s.name));
  for (let i = 0; i < data.services.length; i++) {
    const svc = data.services[i];
    if (svc.vaultAppRoleRef !== undefined && !appRoleNames.has(svc.vaultAppRoleRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' vaultAppRoleRef '${svc.vaultAppRoleRef}' references unknown appRole (defined: ${formatNameSet(appRoleNames)})`,
        path: ['services', i, 'vaultAppRoleRef'],
      });
    }
    if (svc.natsCredentialRef !== undefined && !credentialNames.has(svc.natsCredentialRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsCredentialRef '${svc.natsCredentialRef}' references unknown credential (defined: ${formatNameSet(credentialNames)})`,
        path: ['services', i, 'natsCredentialRef'],
      });
    }
    if (svc.natsRole !== undefined && !roleNames.has(svc.natsRole)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsRole '${svc.natsRole}' references unknown role (defined: ${formatNameSet(roleNames)})`,
        path: ['services', i, 'natsRole'],
      });
    }
    if (svc.natsSigner !== undefined && !signerNames.has(svc.natsSigner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsSigner '${svc.natsSigner}' references unknown signer (defined: ${formatNameSet(signerNames)})`,
        path: ['services', i, 'natsSigner'],
      });
    }
  }
  validateNatsSectionShape(data.nats, ctx);
});

export const updateTemplateMetaSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
});

export const draftVersionSchema = z.object({
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networkTypeDefaults: networkTypeDefaultsSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  // See createTemplateSchema: the "at least one service" rule is a publish
  // check, not a draft check.
  services: z.array(stackServiceDefinitionSchema),
  configFiles: z.array(configFileInputSchema).optional(),
  notes: z.string().max(1000).optional(),
  inputs: z.array(templateInputDeclSchema).optional(),
  vault: templateVaultSectionSchema.optional(),
  nats: templateNatsSectionSchema.optional(),
}).superRefine((data, ctx) => {
  // Mirror templateFileSchema: every services[].vaultAppRoleRef must resolve
  // to a vault.appRoles[].name declared in this same draft body. Otherwise
  // the field would persist as a dangling reference and the apply-time vault
  // orchestrator would silently fail to bind the service to any AppRole.
  const appRoleNames = new Set((data.vault?.appRoles ?? []).map((a) => a.name));
  for (let i = 0; i < data.services.length; i++) {
    const svc = data.services[i];
    if (svc.vaultAppRoleRef !== undefined && !appRoleNames.has(svc.vaultAppRoleRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' vaultAppRoleRef '${svc.vaultAppRoleRef}' references unknown appRole (defined: ${formatNameSet(appRoleNames)})`,
        path: ['services', i, 'vaultAppRoleRef'],
      });
    }
  }
  const credentialNames = new Set((data.nats?.credentials ?? []).map((c) => c.name));
  const roleNames = new Set((data.nats?.roles ?? []).map((r) => r.name));
  const signerNames = new Set((data.nats?.signers ?? []).map((s) => s.name));
  for (let i = 0; i < data.services.length; i++) {
    const svc = data.services[i];
    if (svc.natsCredentialRef !== undefined && !credentialNames.has(svc.natsCredentialRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsCredentialRef '${svc.natsCredentialRef}' references unknown credential (defined: ${formatNameSet(credentialNames)})`,
        path: ['services', i, 'natsCredentialRef'],
      });
    }
    if (svc.natsRole !== undefined && !roleNames.has(svc.natsRole)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsRole '${svc.natsRole}' references unknown role (defined: ${formatNameSet(roleNames)})`,
        path: ['services', i, 'natsRole'],
      });
    }
    if (svc.natsSigner !== undefined && !signerNames.has(svc.natsSigner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsSigner '${svc.natsSigner}' references unknown signer (defined: ${formatNameSet(signerNames)})`,
        path: ['services', i, 'natsSigner'],
      });
    }
  }
  validateNatsSectionShape(data.nats, ctx);
});

/**
 * Reusable cross-section validator for the NATS section. Catches the
 * legacy/new mixing rule, name collisions inside roles/signers, and the
 * per-role `imports[].forRoles` resolution. Called from both
 * `draftVersionSchema` and `templateFileSchema` so the rules apply uniformly
 * to HTTP draft submissions and bundled file-loaded templates.
 */
export function validateNatsSectionShape(
  nats: { accounts?: unknown[]; credentials?: unknown[]; streams?: unknown[]; consumers?: unknown[];
          roles?: Array<{ name: string }>; signers?: Array<{ name: string }>;
          imports?: Array<{ forRoles?: string[] }>; exports?: unknown[]; subjectPrefix?: unknown } | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!nats) return;
  const hasLegacy = (nats.credentials?.length ?? 0) > 0;
  const hasNewRoles = (nats.roles?.length ?? 0) > 0;
  // Mixing rule: a single template must not mix the legacy `credentials`
  // surface with the new `roles` surface. System templates use legacy;
  // app templates use roles. Forces an explicit migration step.
  if (hasLegacy && hasNewRoles) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "nats.credentials (legacy) and nats.roles (new) cannot be declared in the same template — pick one surface",
      path: ["nats", "roles"],
    });
  }

  // Unique role names
  const seenRoleNames = new Set<string>();
  for (let i = 0; i < (nats.roles?.length ?? 0); i++) {
    const r = nats.roles![i];
    if (seenRoleNames.has(r.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate NATS role name: '${r.name}'`,
        path: ["nats", "roles", i, "name"],
      });
    }
    seenRoleNames.add(r.name);
  }

  // Unique signer names
  const seenSignerNames = new Set<string>();
  for (let i = 0; i < (nats.signers?.length ?? 0); i++) {
    const s = nats.signers![i];
    if (seenSignerNames.has(s.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate NATS signer name: '${s.name}'`,
        path: ["nats", "signers", i, "name"],
      });
    }
    seenSignerNames.add(s.name);
  }

  // imports[].forRoles must reference declared roles (per-role binding only).
  for (let i = 0; i < (nats.imports?.length ?? 0); i++) {
    const imp = nats.imports![i];
    for (let j = 0; j < (imp.forRoles?.length ?? 0); j++) {
      const r = imp.forRoles![j];
      if (!seenRoleNames.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `nats.imports[${i}].forRoles references unknown role '${r}' (defined: ${formatNameSet(seenRoleNames)})`,
          path: ["nats", "imports", i, "forRoles", j],
        });
      }
    }
  }
}

function formatNameSet(set: Set<string>): string {
  if (set.size === 0) return 'none defined';
  return Array.from(set)
    .map((n) => `'${n}'`)
    .join(', ');
}

export const publishDraftSchema = z.object({
  notes: z.string().max(1000).optional(),
});

export const instantiateTemplateSchema = z.object({
  environmentId: z.string().min(1).optional(),
  parameterValues: parameterValuesSchema.optional(),
  name: z.string().min(1).max(100).optional(),
  inputValues: z.record(z.string(), z.string()).optional(),
});
