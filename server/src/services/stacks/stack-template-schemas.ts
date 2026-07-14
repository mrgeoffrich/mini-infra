import { z } from "zod";
import { ENVIRONMENT_NETWORK_TYPES } from "@mini-infra/types";
import {
  stackParameterDefinitionSchema,
  parameterValuesSchema,
  stackNetworkEntrySchema,
  stackVolumeSchema,
  stackServiceDefinitionSchema,
  stackResourceOutputSchema,
  stackResourceInputSchema,
  removedField,
} from "./schemas";
import { validateKvPath, stripTemplateTokens } from "../vault/vault-kv-paths";
import { templateRequiresSchema } from "./template-prerequisites/schema";

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

// Imported + re-exported from `./nats-subject-shapes` so the structural
// rules live in a single neutral module that both `schemas.ts` (JobPool
// trigger subjects) and this file (role-nested authoring surface) can
// import without a circular dependency (MINI-50 review finding M2).
import { natsRelativeSubjectSchema } from "./nats-subject-shapes";
export { natsRelativeSubjectSchema };

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

/**
 * The removed low-level NATS authoring surface.
 *
 * These four sections let a template declare NATS accounts, credential
 * profiles, streams and consumers directly, using *absolute* subjects against
 * an explicitly-named account. The role model replaced them: a role declares
 * subjects *relative* to the stack's `subjectPrefix`, which is what makes
 * per-stack isolation enforceable rather than a naming convention.
 *
 * Every system template migrated to roles, and nothing in the product writes
 * this shape any more. The keys stay declared (rather than simply deleted) so
 * a template still carrying them is rejected with a migration path instead of
 * being silently stripped by Zod — see `removedField`.
 *
 * Note this removes only the *template* surface. NATS accounts, streams and
 * consumers still exist as runtime entities, managed through `/api/nats` and
 * created by the control plane and system bootstrap.
 */
export const REMOVED_NATS_TEMPLATE_FIELDS = {
  accounts:
    "nats.accounts[] was removed — roles run on the shared system account and are isolated by subject prefix, so templates no longer declare accounts. Manage accounts via /api/nats.",
  credentials:
    "nats.credentials[] was removed — declare nats.roles[] instead. A role's publish/subscribe subjects are written relative to the stack's nats.subjectPrefix and materialize into a credential profile at apply time.",
  streams:
    "nats.streams[] was removed — declare streams under the role that owns them, as nats.roles[].streams[], with subjects relative to nats.subjectPrefix.",
  consumers:
    "nats.consumers[] was removed — declare consumers under the role that owns them, as nats.roles[].consumers[].",
} as const;

// ----- App-author role / signer / import surface -----

// Role-nested stream: subjects relative to the stack's subjectPrefix. Drops
// `account` (always the shared system account) and `scope` (always stack-
// scoped) — both are implied by the prefix-only isolation model.
export const templateNatsRoleStreamSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex, "stream name can only contain letters, numbers, '_', '-'"),
  description: z.string().max(500).optional(),
  subjects: z.array(natsRelativeSubjectSchema).min(1),
  retention: z.enum(["limits", "interest", "workqueue"]).optional(),
  storage: z.enum(["file", "memory"]).optional(),
  maxMsgs: z.number().int().nullable().optional(),
  maxBytes: z.number().int().nullable().optional(),
  maxAgeSeconds: z.number().int().nullable().optional(),
});

// Role-nested consumer: `stream` references one of the role's own streams
// by declared name (the orchestrator resolves it to the materialized id);
// `filterSubject` is relative to the subjectPrefix and gets prepended.
export const templateNatsRoleConsumerSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex, "consumer name can only contain letters, numbers, '_', '-'"),
  stream: z.string().min(1).max(100),
  durableName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  filterSubject: natsRelativeSubjectSchema.optional(),
  deliverPolicy: z.enum(["all", "last", "new", "by_start_sequence", "by_start_time", "last_per_subject"]).optional(),
  ackPolicy: z.enum(["none", "all", "explicit"]).optional(),
  maxDeliver: z.number().int().nullable().optional(),
  ackWaitSeconds: z.number().int().nullable().optional(),
});

export const templateNatsRoleSchema = z
  .object({
    name: z.string().min(1).max(100).regex(nameRegex, "role name can only contain letters, numbers, '_', '-'"),
    publish: z.array(natsRelativeSubjectSchema).optional(),
    subscribe: z.array(natsRelativeSubjectSchema).optional(),
    inboxAuto: z.enum(["both", "reply", "request", "none"]).optional(),
    // KV bucket names. Each materializes into `$KV.<bucket>.>` on both pub
    // and sub at apply time. Bucket-name rules mirror NATS' validator:
    // alphanumeric + `_`/`-`, ≤100 chars. The orchestrator constructs the
    // absolute subject form so the schema only validates the bucket names.
    kvBuckets: z
      .array(z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "kvBuckets entry: alphanumeric + '_' / '-' only"))
      .optional(),
    streams: z.array(templateNatsRoleStreamSchema).optional(),
    consumers: z.array(templateNatsRoleConsumerSchema).optional(),
    ttlSeconds: z.number().int().min(0).optional(),
  })
  .superRefine((role, ctx) => {
    // Stream + consumer name uniqueness within the role. Names go into
    // composite materialized identifiers (`<stackId>-<roleName>-<streamName>`),
    // so a duplicate would silently overwrite the earlier definition.
    const streamNames = new Set<string>();
    for (let i = 0; i < (role.streams?.length ?? 0); i++) {
      const s = role.streams![i];
      if (streamNames.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate stream name '${s.name}' in role '${role.name}'`,
          path: ["streams", i, "name"],
        });
      }
      streamNames.add(s.name);
    }
    const consumerNames = new Set<string>();
    for (let i = 0; i < (role.consumers?.length ?? 0); i++) {
      const c = role.consumers![i];
      if (consumerNames.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate consumer name '${c.name}' in role '${role.name}'`,
          path: ["consumers", i, "name"],
        });
      }
      consumerNames.add(c.name);
      // Consumer.stream must reference a stream declared on this same role.
      if (!streamNames.has(c.stream)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Consumer '${c.name}' references unknown stream '${c.stream}' in role '${role.name}' (defined: ${
            streamNames.size === 0 ? "none" : Array.from(streamNames).map((n) => `'${n}'`).join(", ")
          })`,
          path: ["consumers", i, "stream"],
        });
      }
    }
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
  subjectPrefix: templateNatsSubjectPrefixSchema.optional(),
  roles: z.array(templateNatsRoleSchema).optional(),
  signers: z.array(templateNatsSignerSchema).optional(),
  exports: z.array(natsRelativeSubjectSchema).optional(),
  imports: z.array(templateNatsImportSchema).optional(),

  // Removed — see REMOVED_NATS_TEMPLATE_FIELDS.
  accounts: removedField(REMOVED_NATS_TEMPLATE_FIELDS.accounts),
  credentials: removedField(REMOVED_NATS_TEMPLATE_FIELDS.credentials),
  streams: removedField(REMOVED_NATS_TEMPLATE_FIELDS.streams),
  consumers: removedField(REMOVED_NATS_TEMPLATE_FIELDS.consumers),
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
  networks: z.array(stackNetworkEntrySchema),
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
  // Phase 1 cross-stack prereqs. Predicate names validated against the
  // server-side registry — typos rejected at draft-save time.
  requires: templateRequiresSchema.optional(),
}).superRefine((data, ctx) => {
  // Mirror draftVersionSchema: vaultAppRoleRef / natsRole / natsSigner must
  // resolve to something declared in this same body, and role + signer names
  // must be unique. Without this, a POST /stack-templates carrying a dangling
  // ref would persist on the initial v0 draft and only fail on a later save.
  validateTemplateServiceRefs(data, ctx);
  validateNatsSectionShape(data.nats, ctx);
});

export const updateTemplateMetaSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
  // Soft-archive toggle. Archived templates are hidden from the default list
  // (surfaced only when `includeArchived` is set) but their linked stacks are
  // left completely untouched — distinct from DELETE, which tears them down.
  isArchived: z.boolean().optional(),
});

export const draftVersionSchema = z.object({
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networkTypeDefaults: networkTypeDefaultsSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkEntrySchema),
  volumes: z.array(stackVolumeSchema),
  // See createTemplateSchema: the "at least one service" rule is a publish
  // check, not a draft check.
  services: z.array(stackServiceDefinitionSchema),
  configFiles: z.array(configFileInputSchema).optional(),
  notes: z.string().max(1000).optional(),
  inputs: z.array(templateInputDeclSchema).optional(),
  vault: templateVaultSectionSchema.optional(),
  nats: templateNatsSectionSchema.optional(),
  // Phase 1 cross-stack prereqs — see createTemplateSchema.
  requires: templateRequiresSchema.optional(),
}).superRefine((data, ctx) => {
  validateTemplateServiceRefs(data, ctx);
  validateNatsSectionShape(data.nats, ctx);
});

/**
 * Every symbolic reference a service declares must resolve to something
 * declared in the same template body. A dangling ref would otherwise persist
 * and the apply-time orchestrator would silently fail to bind the service to
 * any AppRole / credential profile.
 *
 * Shared by `createTemplateSchema` and `draftVersionSchema` (and mirrored by
 * `templateFileSchema`) so the create → draft → publish surfaces can't drift
 * apart on which refs they check.
 */
function validateTemplateServiceRefs(
  data: {
    services: Array<{
      serviceName: string;
      vaultAppRoleRef?: string;
      natsRole?: string;
      natsSigner?: string;
    }>;
    vault?: { appRoles?: Array<{ name: string }> };
    nats?: { roles?: Array<{ name: string }>; signers?: Array<{ name: string }> };
  },
  ctx: z.RefinementCtx,
): void {
  const targets = [
    {
      field: 'vaultAppRoleRef' as const,
      label: 'appRole',
      names: new Set((data.vault?.appRoles ?? []).map((a) => a.name)),
    },
    {
      field: 'natsRole' as const,
      label: 'role',
      names: new Set((data.nats?.roles ?? []).map((r) => r.name)),
    },
    {
      field: 'natsSigner' as const,
      label: 'signer',
      names: new Set((data.nats?.signers ?? []).map((s) => s.name)),
    },
  ];

  for (let i = 0; i < data.services.length; i++) {
    const svc = data.services[i];
    for (const { field, label, names } of targets) {
      const ref = svc[field];
      if (ref !== undefined && !names.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Service '${svc.serviceName}' ${field} '${ref}' references unknown ${label} (defined: ${formatNameSet(names)})`,
          path: ['services', i, field],
        });
      }
    }
  }
}

/**
 * Reusable cross-section validator for the NATS section: name collisions
 * inside roles/signers, and the per-role `imports[].forRoles` resolution.
 * Called from `createTemplateSchema`, `draftVersionSchema` and
 * `templateFileSchema` so the rules apply uniformly to HTTP submissions and
 * bundled file-loaded templates.
 */
export function validateNatsSectionShape(
  nats: { roles?: Array<{ name: string; streams?: unknown[]; consumers?: unknown[] }>; signers?: Array<{ name: string }>;
          imports?: Array<{ forRoles?: string[] }>; exports?: unknown[]; subjectPrefix?: unknown } | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!nats) return;

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
