import type { PrismaClient } from "../../lib/prisma";
import { Prisma } from "../../generated/prisma/client";
import {
  buildTemplateContext,
  resolveTemplate,
  type TemplateContextEnvironment,
} from "./template-engine";
import { mergeParameterValues } from "./utils";
import { NatsBus } from "../nats/nats-bus";
import { getNatsControlPlaneService, natsSignerSeedKvPath } from "../nats/nats-control-plane-service";
import { NatsPrefixAllowlistService } from "../nats/nats-prefix-allowlist-service";
import { ensureEgressGatewaySeeded } from "../nats/system-nats-bootstrap";
import { generateScopedSigningKey } from "../nats/nats-key-manager";
import { getVaultKVService } from "../vault/vault-kv-service";
import { getLogger } from "../../lib/logger-factory";
import type {
  EnvironmentNetworkType,
  EnvironmentType,
  StackParameterDefinition,
  StackParameterValue,
  TemplateNatsAccount,
  TemplateNatsConsumer,
  TemplateNatsCredential,
  TemplateNatsImport,
  TemplateNatsRole,
  TemplateNatsSigner,
  TemplateNatsStream,
} from "@mini-infra/types";

export type NatsApplyPhaseStatus = "applied" | "noop" | "skipped" | "error";

export interface NatsApplyPhaseResult {
  status: NatsApplyPhaseStatus;
  servicesBound?: number;
  credentialsMapped?: number;
  error?: string;
}

export interface NatsApplyPhaseOptions {
  triggeredBy: string | undefined;
  requireNatsReady?: boolean;
}

export async function runStackNatsApplyPhase(
  prisma: PrismaClient,
  stackId: string,
  opts: NatsApplyPhaseOptions,
): Promise<NatsApplyPhaseResult> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    include: {
      environment: true,
      services: { orderBy: { order: "asc" } },
    },
  });
  if (!stack?.templateId || stack.templateVersion == null) return { status: "skipped" };

  // Resolve the template's name so we can self-heal the system NATS seed
  // for templates that depend on it (e.g. egress-gateway needs the
  // `mini-infra.egress.gw` prefix-allowlist entry to clear validation).
  const template = await prisma.stackTemplate.findUnique({
    where: { id: stack.templateId },
    select: { id: true, name: true },
  });

  const templateVersion = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stack.templateId, version: stack.templateVersion },
    select: {
      natsAccounts: true,
      natsCredentials: true,
      natsStreams: true,
      natsConsumers: true,
      // Phase 1 fields (app-author surface). Phase 3 materializes `roles`
      // and reads `subjectPrefix`; Phase 4 will use `signers`; Phase 5 will
      // use `imports`/`exports`.
      natsSubjectPrefix: true,
      natsRoles: true,
      natsSigners: true,
      natsExports: true,
      natsImports: true,
      services: {
        select: {
          serviceName: true,
          natsCredentialRef: true,
          natsRole: true,
          natsSigner: true,
        },
      },
    },
  });
  if (!templateVersion) return { status: "skipped" };

  const accounts = (templateVersion.natsAccounts as TemplateNatsAccount[] | null) ?? [];
  const credentials = (templateVersion.natsCredentials as TemplateNatsCredential[] | null) ?? [];
  const streams = (templateVersion.natsStreams as TemplateNatsStream[] | null) ?? [];
  const consumers = (templateVersion.natsConsumers as TemplateNatsConsumer[] | null) ?? [];
  const roles = (templateVersion.natsRoles as TemplateNatsRole[] | null) ?? [];
  const signers = (templateVersion.natsSigners as TemplateNatsSigner[] | null) ?? [];
  const exportsRelative = (templateVersion.natsExports as string[] | null) ?? [];
  const imports = (templateVersion.natsImports as TemplateNatsImport[] | null) ?? [];
  // Phase 3 expands the guard to include the new app-author surface so
  // pure-roles templates still trigger the apply phase. Mixing is rejected
  // at validation (Phase 1's `validateNatsSectionShape`), so legacy and new
  // paths run side-by-side without colliding. Phase 5 adds exports/imports
  // to the guard for cross-stack subject sharing.
  const hasNats =
    accounts.length > 0 ||
    credentials.length > 0 ||
    streams.length > 0 ||
    consumers.length > 0 ||
    roles.length > 0 ||
    signers.length > 0 ||
    exportsRelative.length > 0 ||
    imports.length > 0;
  if (!hasNats) return { status: "skipped" };

  const status = await getNatsControlPlaneService(prisma).getStatus();
  if (!status.configured && opts.requireNatsReady) {
    throw new Error("NATS is not configured; deploy the vault-nats stack before applying a NATS-bearing template");
  }

  // System NATS seed self-heal: if the boot-time seed failed (DB race on
  // first install, or NATS not yet up), the prefix-allowlist + JetStream
  // rows for the egress-gateway namespace would be missing — and the apply
  // below would fail allowlist validation. Re-run the seed here for the
  // egress-gateway template before going further. Idempotent on the
  // happy path (every operation is upsert).
  if (template && template.name === "egress-gateway") {
    try {
      await ensureEgressGatewaySeeded(prisma, new Map([[template.name, { id: template.id }]]));
    } catch (err) {
      getLogger("integrations", "nats-apply-orchestrator").warn(
        { err: err instanceof Error ? err.message : String(err) },
        "ensureEgressGatewaySeeded failed during stack apply (proceeding; allowlist validation may reject)",
      );
    }
  }

  try {
    const params = mergeParameterValues(
      (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {},
    );
    const environment: TemplateContextEnvironment | undefined = stack.environment
      ? {
          id: stack.environment.id,
          name: stack.environment.name,
          type: stack.environment.type as EnvironmentType,
          networkType: stack.environment.networkType as EnvironmentNetworkType,
        }
      : undefined;
    const ctx = buildTemplateContext(
      {
        name: stack.name,
        networks: (stack.networks as unknown as Parameters<typeof buildTemplateContext>[0]["networks"]) ?? [],
        volumes: (stack.volumes as unknown as Parameters<typeof buildTemplateContext>[0]["volumes"]) ?? [],
      },
      stack.services.map((s) => ({
        serviceName: s.serviceName,
        dockerImage: s.dockerImage,
        dockerTag: s.dockerTag,
        containerConfig: s.containerConfig as Parameters<typeof buildTemplateContext>[1][number]["containerConfig"],
      })),
      { stackId, environment, params },
    );

    const service = getNatsControlPlaneService(prisma);
    const accountIdByName = new Map<string, string>();
    const credentialIdByName = new Map<string, string>();
    const streamIdByName = new Map<string, string>();
    const resources: Array<{ type: string; concreteName: string; scope?: string }> = [];

    await service.ensureDefaultAccount();

    for (const account of accounts) {
      const name = concreteName(render(account.name, ctx), account.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsAccount.findUnique({ where: { name } });
      const row = existing
        ? await prisma.natsAccount.update({
            where: { id: existing.id },
            data: {
              displayName: account.displayName ?? name,
              description: account.description ?? null,
              updatedById: opts.triggeredBy ?? null,
            },
          })
        : await prisma.natsAccount.create({
            data: {
              name,
              displayName: account.displayName ?? name,
              description: account.description ?? null,
              seedKvPath: `shared/nats-accounts/${name}`,
              createdById: opts.triggeredBy ?? null,
              updatedById: opts.triggeredBy ?? null,
            },
          });
      accountIdByName.set(account.name, row.id);
      resources.push({ type: "account", concreteName: name, scope: account.scope });
    }

    for (const credential of credentials) {
      const accountId = accountIdByName.get(credential.account)
        ?? (await prisma.natsAccount.findUnique({ where: { name: credential.account } }))?.id;
      if (!accountId) throw new Error(`NATS credential '${credential.name}' references unknown account '${credential.account}'`);
      const name = concreteName(render(credential.name, ctx), credential.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsCredentialProfile.findUnique({ where: { name } });
      const data = {
        displayName: credential.displayName ?? name,
        description: credential.description ?? null,
        accountId,
        publishAllow: credential.publishAllow.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        subscribeAllow: credential.subscribeAllow.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        ttlSeconds: credential.ttlSeconds ?? 3600,
        updatedById: opts.triggeredBy ?? null,
      };
      const row = existing
        ? await prisma.natsCredentialProfile.update({ where: { id: existing.id }, data })
        : await prisma.natsCredentialProfile.create({
            data: {
              name,
              ...data,
              createdById: opts.triggeredBy ?? null,
            },
          });
      credentialIdByName.set(credential.name, row.id);
      resources.push({ type: "credential", concreteName: name, scope: credential.scope });
    }

    for (const stream of streams) {
      const accountId = accountIdByName.get(stream.account)
        ?? (await prisma.natsAccount.findUnique({ where: { name: stream.account } }))?.id;
      if (!accountId) throw new Error(`NATS stream '${stream.name}' references unknown account '${stream.account}'`);
      const name = concreteName(render(stream.name, ctx), stream.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsStream.findUnique({ where: { name } });
      const data = {
        accountId,
        description: stream.description ?? null,
        subjects: stream.subjects.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        retention: stream.retention ?? "limits",
        storage: stream.storage ?? "file",
        maxMsgs: stream.maxMsgs ?? null,
        maxBytes: stream.maxBytes ?? null,
        maxAgeSeconds: stream.maxAgeSeconds ?? null,
        updatedById: opts.triggeredBy ?? null,
      };
      const row = existing
        ? await prisma.natsStream.update({ where: { id: existing.id }, data })
        : await prisma.natsStream.create({
            data: {
              name,
              ...data,
              createdById: opts.triggeredBy ?? null,
            },
          });
      streamIdByName.set(stream.name, row.id);
      resources.push({ type: "stream", concreteName: name, scope: stream.scope });
    }

    for (const consumer of consumers) {
      const streamId = streamIdByName.get(consumer.stream)
        ?? (await prisma.natsStream.findUnique({ where: { name: consumer.stream } }))?.id;
      if (!streamId) throw new Error(`NATS consumer '${consumer.name}' references unknown stream '${consumer.stream}'`);
      const name = concreteName(render(consumer.name, ctx), consumer.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsConsumer.findFirst({ where: { streamId, name } });
      const data = {
        durableName: consumer.durableName ? render(consumer.durableName, ctx) : name,
        description: consumer.description ?? null,
        filterSubject: consumer.filterSubject ? render(consumer.filterSubject, ctx) : null,
        deliverPolicy: consumer.deliverPolicy ?? "all",
        ackPolicy: consumer.ackPolicy ?? "explicit",
        maxDeliver: consumer.maxDeliver ?? null,
        ackWaitSeconds: consumer.ackWaitSeconds ?? null,
        updatedById: opts.triggeredBy ?? null,
      };
      if (existing) {
        await prisma.natsConsumer.update({ where: { id: existing.id }, data });
      } else {
        await prisma.natsConsumer.create({
          data: {
            streamId,
            name,
            ...data,
            createdById: opts.triggeredBy ?? null,
          },
        });
      }
      resources.push({ type: "consumer", concreteName: name, scope: consumer.scope });
    }

    // ─── Phase 3 + 5: app-author roles materialization + cross-stack imports ──
    // Roles share the system-default account (prefix-only isolation, see
    // design §2.1 decision 1). Each role becomes a NatsCredentialProfile
    // with `<resolvedSubjectPrefix>.` prepended to every publish/subscribe
    // entry, plus `_INBOX.>` injection per the role's `inboxAuto` setting.
    // The mixing rule (Phase 1) prevents `roles` and legacy `credentials`
    // from coexisting in one template, so the maps below stay disjoint.
    //
    // Phase 5 adds cross-stack imports: for each `nats.imports[]` entry, the
    // producer's resolved exports are looked up and the matched subjects
    // get appended (in absolute form) to the subscribe list of every role
    // named in `forRoles`. The producer's snapshot (`lastAppliedNatsSnapshot`)
    // is the source of truth — written by the producer's own apply phase.
    let resolvedSubjectPrefix: string | null = null;
    const roleCredentialIdByName = new Map<string, string>();
    let resolvedExports: string[] = [];
    const renderedRoleProfileNames = new Set<string>();
    const renderedSignerNames = new Set<string>();
    if (roles.length > 0 || signers.length > 0 || exportsRelative.length > 0 || imports.length > 0) {
      const defaultAccount = await service.ensureDefaultAccount();
      resolvedSubjectPrefix = await resolveAndValidateSubjectPrefix({
        prisma,
        rawPrefix: templateVersion.natsSubjectPrefix ?? null,
        ctx,
        stackId,
        templateId: stack.templateId,
      });

      // Resolve our own exports for snapshot consumption by other stacks.
      resolvedExports = exportsRelative.map((s) => `${resolvedSubjectPrefix}.${s}`);

      // Resolve imports: per-role additional subscribe subjects (absolute,
      // already prefixed by the *producer's* prefix). Validate fromStack
      // exists + is applied + actually exports a matching pattern.
      const declaredRoleNames = new Set(roles.map((r) => r.name));
      const importedSubscribeByRole = new Map<string, string[]>();
      for (const imp of imports) {
        for (const r of imp.forRoles) {
          if (!declaredRoleNames.has(r)) {
            // Phase 1 validator should have caught this; fail loud at apply
            // if a corrupt template made it through.
            throw new Error(`NATS apply: imports[].forRoles references undeclared role '${r}'`);
          }
        }
        const resolved = await resolveImport({
          prisma,
          imp,
          consumerStackId: stackId,
          consumerEnvironmentId: stack.environmentId,
        });
        for (const r of imp.forRoles) {
          const list = importedSubscribeByRole.get(r) ?? [];
          list.push(...resolved);
          importedSubscribeByRole.set(r, list);
        }
      }

      for (const role of roles) {
        const profile = await materializeRole({
          prisma,
          role,
          accountId: defaultAccount.id,
          subjectPrefix: resolvedSubjectPrefix,
          stackId,
          stackName: stack.name,
          triggeredBy: opts.triggeredBy,
          additionalSubscribeAbsolute: importedSubscribeByRole.get(role.name) ?? [],
        });
        roleCredentialIdByName.set(role.name, profile.id);
        renderedRoleProfileNames.add(profile.name);
        resources.push({ type: "credential", concreteName: profile.name, scope: "stack" });
      }

      // Phase 4: signers materialization. Each signer becomes a NatsSigningKey
      // row + a Vault KV seed. The actual scope-template splice into the
      // account JWT happens in service.applyConfig() below, which now reads
      // every NatsSigningKey row and re-issues each affected account's JWT
      // with the live signing-keys list. The full-resolver propagation then
      // pushes the new claim via $SYS.REQ.CLAIMS.UPDATE.
      for (const signer of signers) {
        const sk = await materializeSigner({
          prisma,
          signer,
          accountId: defaultAccount.id,
          subjectPrefix: resolvedSubjectPrefix,
          stackId,
        });
        renderedSignerNames.add(signer.name);
        resources.push({ type: "signing-key", concreteName: sk.publicKey, scope: "stack" });
      }

      // Diff-and-prune. Run before applyConfig() so the re-issued account
      // JWT reflects only the live set of signing keys + the orphan profiles
      // are gone before any service tries to rebind to them.
      await pruneOrphanRoleProfiles({
        prisma,
        stackId,
        desiredProfileNames: renderedRoleProfileNames,
      });
      await pruneOrphanSigningKeys({
        prisma,
        stackId,
        desiredSignerNames: renderedSignerNames,
      });
    }

    await service.applyConfig();
    // `applyConfig()` rotates the server's own bus credentials in Vault KV
    // every run (alongside the per-account JWTs). Without forcing the
    // running bus to re-read those creds, the live connection silently
    // continues authenticating with a stale `.creds` blob — same lifecycle
    // gap that bit Phase 1's `/api/nats/apply` route. Mirror that fix here.
    NatsBus.getInstance().invalidateCreds();
    await service.applyJetStreamResources();

    const credentialRefByService = new Map(
      templateVersion.services
        .filter((s) => s.natsCredentialRef != null)
        .map((s) => [s.serviceName, s.natsCredentialRef as string]),
    );
    const roleRefByService = new Map(
      templateVersion.services
        .filter((s) => s.natsRole != null)
        .map((s) => [s.serviceName, s.natsRole as string]),
    );
    const serviceUpdates = stack.services
      .map((svc) => {
        // Legacy `natsCredentialRef` and new `natsRole` are mutually
        // exclusive (template-level mixing rule + service-level "either or"
        // by convention). Prefer role binding when both happen to exist —
        // a defensive choice; the validator should have already rejected.
        const roleRef = roleRefByService.get(svc.serviceName);
        const credRef = credentialRefByService.get(svc.serviceName);
        const concreteId = roleRef
          ? roleCredentialIdByName.get(roleRef)
          : credRef
            ? credentialIdByName.get(credRef)
            : undefined;
        return concreteId ? { id: svc.id, natsCredentialId: concreteId } : null;
      })
      .filter((item): item is { id: string; natsCredentialId: string } => item !== null);

    await prisma.$transaction([
      prisma.stack.update({
        where: { id: stackId },
        data: {
          lastAppliedNatsSnapshot: JSON.stringify({
            accounts,
            credentials,
            streams,
            consumers,
            resources,
            // Phase 3: snapshot the resolved prefix and the materialized
            // role permissions so drift detection can compare cleanly.
            subjectPrefix: resolvedSubjectPrefix,
            roles,
            // Phase 4: snapshot the signers so a future drift detector can
            // compare the rendered scope envelope against what's live.
            signers,
            // Phase 5: snapshot the resolved (prefixed) exports so consumer
            // stacks can read them directly without re-resolving the
            // producer's prefix at consumer-apply time.
            resolvedExports,
            imports,
          }),
          lastFailureReason: null,
        },
      }),
      prisma.stackNatsResource.deleteMany({ where: { stackId } }),
      ...resources.map((resource) =>
        prisma.stackNatsResource.create({
          data: {
            stackId,
            type: resource.type,
            concreteName: resource.concreteName,
            scope: resource.scope ?? null,
          },
        }),
      ),
      ...serviceUpdates.map((update) =>
        prisma.stackService.update({
          where: { id: update.id },
          data: { natsCredentialId: update.natsCredentialId },
        }),
      ),
    ]);

    return {
      status: "applied",
      servicesBound: serviceUpdates.length,
      // Count both legacy and Phase 3 role-derived profiles so a pure-roles
      // stack reports a non-zero figure in logs/Socket.IO progress.
      credentialsMapped: credentialIdByName.size + roleCredentialIdByName.size,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.stack.update({
      where: { id: stackId },
      data: { status: "error", lastFailureReason: error },
    });
    return { status: "error", error };
  }
}

function render(value: string, ctx: Parameters<typeof resolveTemplate>[1]): string {
  return value.includes("{{") ? resolveTemplate(value, ctx) : value;
}

function concreteName(base: string, scope: string, stackName: string, environmentName: string | null): string {
  const prefix =
    scope === "host"
      ? "host"
      : scope === "stack"
        ? stackName
        : environmentName ?? stackName;
  return `${prefix}-${base}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

// =====================================================================
// Phase 3 helpers — subject prefix resolution + role materialization
// =====================================================================

/** Default subject-prefix template applied when a template doesn't set one. */
const DEFAULT_SUBJECT_PREFIX_TEMPLATE = "app.{{stack.id}}";

/**
 * Resolve and validate the stack's NATS subject prefix.
 *
 * Defaults to `app.<stack.id>` (opaque but collision-free). A non-default
 * prefix requires the templateId to appear in the matching `nats-prefix-
 * allowlist` entry — without that gate any template author could grab a
 * shared namespace like `events` and shadow another stack's subjects (the
 * design's named footgun).
 *
 * Returns the resolved (substituted) prefix string. Throws on:
 *   - escape attempts that the static validator should have caught earlier
 *     (defense in depth — a corrupt JSON column, a future schema drift, etc.)
 *   - non-default prefix without an allowlist entry
 *   - allowlist entry exists but doesn't list this template
 */
async function resolveAndValidateSubjectPrefix(args: {
  prisma: PrismaClient;
  rawPrefix: string | null;
  ctx: Parameters<typeof resolveTemplate>[1];
  stackId: string;
  templateId: string;
}): Promise<string> {
  const rawTemplate = args.rawPrefix ?? DEFAULT_SUBJECT_PREFIX_TEMPLATE;
  const resolved = render(rawTemplate, args.ctx);
  const defaultResolved = render(DEFAULT_SUBJECT_PREFIX_TEMPLATE, args.ctx);

  // Defense-in-depth: re-check the prefix shape at apply time. Phase 1's
  // schema validator already enforces these, but a corrupt natsSubjectPrefix
  // column (e.g. via a future direct-Prisma write) would otherwise reach the
  // permission renderer with a wildcard and shadow the prefix tree.
  if (!resolved || /[>*]/.test(resolved) || resolved.startsWith(".") || resolved.endsWith(".") || resolved === "$SYS" || resolved.startsWith("$SYS.")) {
    throw new Error(
      `NATS apply: invalid subjectPrefix '${resolved}' (must be non-empty, no wildcards, no leading/trailing dot, not $SYS)`,
    );
  }

  if (resolved === defaultResolved) {
    return resolved;
  }

  // Non-default → must be admin-allowlisted for this template ID.
  const allowlist = new NatsPrefixAllowlistService(args.prisma);
  const allowedTemplateIds = await allowlist.lookupAllowedTemplateIds(resolved);
  if (!allowedTemplateIds) {
    throw new Error(
      `NATS apply: subjectPrefix '${resolved}' is not in the prefix allowlist. ` +
        `Either remove the explicit subjectPrefix to use the default (${defaultResolved}), ` +
        `or add an allowlist entry via POST /api/nats/prefix-allowlist.`,
    );
  }
  if (!allowedTemplateIds.includes(args.templateId)) {
    throw new Error(
      `NATS apply: subjectPrefix '${resolved}' is allowlisted but template '${args.templateId}' is not in its allowedTemplateIds.`,
    );
  }

  getLogger("integrations", "nats-apply-orchestrator").info(
    { stackId: args.stackId, templateId: args.templateId, subjectPrefix: resolved },
    "applied non-default NATS subject prefix",
  );
  return resolved;
}

/**
 * Materialize a single `roles[]` entry into a `NatsCredentialProfile` row.
 * Permissions are auto-prefixed with the resolved subjectPrefix and (per
 * `inboxAuto`) `_INBOX.>` is injected on publish, subscribe, both, or
 * neither — defaulting to `'both'` so the slackbot's request/reply pattern
 * works without explicit `_INBOX` declarations (design §1.4 calls this out
 * as the team's recurring footgun).
 */
async function materializeRole(args: {
  prisma: PrismaClient;
  role: TemplateNatsRole;
  accountId: string;
  subjectPrefix: string;
  stackId: string;
  stackName: string;
  triggeredBy: string | undefined;
  /**
   * Phase 5: subjects from cross-stack imports already in absolute form
   * (prefixed by the *producer's* subject prefix). These get added to the
   * subscribe list as-is — never run through the prefix-prepend or relative-
   * subject validators.
   */
  additionalSubscribeAbsolute?: string[];
}): Promise<{ id: string; name: string }> {
  const { role, subjectPrefix } = args;
  const inboxAuto = role.inboxAuto ?? "both";

  // Defense-in-depth at apply time. The static validator
  // (`natsRelativeSubjectSchema` in stack-template-schemas.ts) is the
  // primary gate; this is here so a corrupt DB column or future schema
  // drift can't sneak a malformed subject through to the permission
  // renderer. Keep the rules in sync with the static schema.
  const validateRelative = (s: string): void => {
    if (!s || s.startsWith(">") || s.startsWith("*")) {
      throw new Error(`NATS apply: role '${role.name}' has subject '${s}' that escapes the prefix`);
    }
    if (s.startsWith("_INBOX.")) {
      throw new Error(`NATS apply: role '${role.name}' subject '${s}' uses _INBOX.> directly — use inboxAuto`);
    }
    if (s.startsWith("$SYS.") || s === "$SYS") {
      throw new Error(`NATS apply: role '${role.name}' subject '${s}' targets the $SYS namespace`);
    }
    if (s.includes("..") || s.split(".").some((tok) => tok.length === 0)) {
      throw new Error(`NATS apply: role '${role.name}' subject '${s}' has empty tokens (leading/trailing dot or '..')`);
    }
  };

  const buildList = (relative: string[] | undefined, includeInbox: boolean): string[] => {
    const list: string[] = [];
    for (const r of relative ?? []) {
      validateRelative(r);
      list.push(`${subjectPrefix}.${r}`);
    }
    if (includeInbox) list.push("_INBOX.>");
    return list;
  };

  const publishAllow = buildList(role.publish, inboxAuto === "both" || inboxAuto === "reply");
  const subscribeAllow = buildList(role.subscribe, inboxAuto === "both" || inboxAuto === "request");
  // Phase 5: imports-derived subjects are already absolute (producer-prefixed)
  // — append after the relative→absolute prepend pass.
  if (args.additionalSubscribeAbsolute && args.additionalSubscribeAbsolute.length > 0) {
    subscribeAllow.push(...args.additionalSubscribeAbsolute);
  }
  // ALT-27: KV bucket access. KV subjects live in the `$KV.>` system tree,
  // outside the stack's prefix, so they can't be expressed via the relative
  // `publish`/`subscribe` lists. Each bucket B gets `$KV.B.>` on BOTH lists
  // — KV Put needs pub, Get/watch needs sub. Defense-in-depth name re-check
  // matches the schema regex so a corrupt DB row can't slip an injection
  // vector through to the permission renderer.
  for (const bucket of role.kvBuckets ?? []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(bucket) || bucket.length === 0 || bucket.length > 100) {
      throw new Error(`NATS apply: role '${role.name}' kvBuckets entry '${bucket}' is invalid`);
    }
    const subj = `$KV.${bucket}.>`;
    publishAllow.push(subj);
    subscribeAllow.push(subj);
  }

  // Profile name: `<stackId>-<roleName>`. `stack.id` is opaque but
  // collision-free — two stacks with the same `name` (host scope) would
  // otherwise clobber each other (design §2.1 decision 2). UI can render
  // a friendlier `<stackName>-<roleName>` derived from this row.
  //
  // The `stackId` FK lets `pruneOrphanRoleProfiles` clean up rows when a
  // role is renamed or removed from a template — without it the DB would
  // just keep accumulating dead `<stackId>-<oldName>` rows.
  const profileName = concreteName(role.name, "stack", args.stackId, null);

  const existing = await args.prisma.natsCredentialProfile.findUnique({ where: { name: profileName } });
  const data = {
    accountId: args.accountId,
    stackId: args.stackId,
    displayName: `${args.stackName}-${role.name}`,
    description: `Phase 3 materialized role for stack ${args.stackName}`,
    publishAllow: publishAllow as unknown as Prisma.InputJsonValue,
    subscribeAllow: subscribeAllow as unknown as Prisma.InputJsonValue,
    ttlSeconds: role.ttlSeconds ?? 3600,
    updatedById: args.triggeredBy ?? null,
  };
  const row = existing
    ? await args.prisma.natsCredentialProfile.update({ where: { id: existing.id }, data })
    : await args.prisma.natsCredentialProfile.create({
        data: {
          name: profileName,
          ...data,
          createdById: args.triggeredBy ?? null,
        },
      });
  return { id: row.id, name: profileName };
}

// =====================================================================
// Phase 4 helpers — signers materialization + orphan cleanup
// =====================================================================

/**
 * Materialize a single `signers[]` entry. The seed lives in Vault KV at
 * `shared/nats-signers/<stackId>-<name>`; the public key + scope are
 * mirrored on a `NatsSigningKey` row so the destroy path can revoke
 * cleanly (the row is the inventory; Vault is the secret store).
 *
 * Reuses an existing keypair if `subjectScope` and `maxTtlSeconds` are
 * unchanged — rotating the key only when the scope envelope shifts. The
 * orchestrator's `applyConfig()` call (after all roles + signers are
 * materialized) is what splices the live `NatsSigningKey` rows into the
 * account JWT and pushes via `$SYS.REQ.CLAIMS.UPDATE`.
 */
/**
 * Same regex `nats-control-plane-service.ts` validates account/credential/
 * stream names with — applied here so a corrupt or hostile signers JSON
 * blob can't smuggle a name with shell-special chars or path separators
 * through to the Vault KV path or env var key.
 */
const SIGNER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

async function materializeSigner(args: {
  prisma: PrismaClient;
  signer: TemplateNatsSigner;
  accountId: string;
  subjectPrefix: string;
  stackId: string;
}): Promise<{ id: string; publicKey: string }> {
  const { signer, subjectPrefix, stackId } = args;

  if (!SIGNER_NAME_RE.test(signer.name)) {
    throw new Error(
      `NATS apply: signer name '${signer.name}' must be lowercase alphanumeric with optional '-' or '_' (max 100 chars)`,
    );
  }

  // Defense-in-depth: same shape rules as roles. The Phase 1 schema is the
  // primary gate, but a corrupt natsSigners JSON column could otherwise
  // sneak a wildcard through to the scope renderer.
  const scope = signer.subjectScope;
  if (
    !scope || /[>*]/.test(scope) || scope.startsWith(".") || scope.endsWith(".") ||
    scope.startsWith("$SYS.") || scope === "$SYS" || scope.startsWith("_INBOX.") ||
    scope.includes("..") || scope.split(".").some((tok) => tok.length === 0)
  ) {
    throw new Error(`NATS apply: signer '${signer.name}' has invalid subjectScope '${scope}'`);
  }

  const scopedSubject = `${subjectPrefix}.${scope}.>`;
  const maxTtlSeconds = signer.maxTtlSeconds ?? 3600;

  const existing = await args.prisma.natsSigningKey.findUnique({
    where: { stackId_name: { stackId, name: signer.name } },
  });

  // Reuse the existing keypair only if neither the scope nor the parent
  // account changed. A scope change rotates the key (old splice removed
  // from the account JWT on the next applyConfig, new spliced in).
  if (existing && existing.scopedSubject === scopedSubject && existing.accountId === args.accountId) {
    await args.prisma.natsSigningKey.update({
      where: { id: existing.id },
      data: { scope, maxTtlSeconds },
    });
    return { id: existing.id, publicKey: existing.publicKey };
  }

  const material = generateScopedSigningKey({ role: signer.name, scopedSubject });
  const seedKvPath = natsSignerSeedKvPath(stackId, signer.name);
  await getVaultKVService().write(seedKvPath, {
    seed: material.seed,
    public_key: material.publicKey,
    scoped_subject: scopedSubject,
  });

  const row = existing
    ? await args.prisma.natsSigningKey.update({
        where: { id: existing.id },
        data: {
          accountId: args.accountId,
          scope,
          scopedSubject,
          publicKey: material.publicKey,
          seedKvPath,
          maxTtlSeconds,
        },
      })
    : await args.prisma.natsSigningKey.create({
        data: {
          accountId: args.accountId,
          stackId,
          name: signer.name,
          scope,
          scopedSubject,
          publicKey: material.publicKey,
          seedKvPath,
          maxTtlSeconds,
        },
      });
  return { id: row.id, publicKey: row.publicKey };
}

/**
 * Drop `NatsCredentialProfile` rows owned by this stack whose names aren't
 * in the freshly-rendered set. Catches role renames + removals; the FK's
 * onDelete cascade handles the cross-table fan-out (no service still
 * referencing the profile because the apply just rebound them).
 */
async function pruneOrphanRoleProfiles(args: {
  prisma: PrismaClient;
  stackId: string;
  desiredProfileNames: Set<string>;
}): Promise<number> {
  const existing = await args.prisma.natsCredentialProfile.findMany({
    where: { stackId: args.stackId },
    select: { id: true, name: true },
  });
  const orphanIds = existing
    .filter((row) => !args.desiredProfileNames.has(row.name))
    .map((row) => row.id);
  if (orphanIds.length === 0) return 0;
  // Service rows referencing these profiles get cleared first to satisfy
  // the FK; the relation is ON DELETE SET NULL on StackService, so this
  // is just a precautionary unbind for any service the apply *didn't*
  // rebind in the same pass.
  await args.prisma.stackService.updateMany({
    where: { natsCredentialId: { in: orphanIds } },
    data: { natsCredentialId: null },
  });
  await args.prisma.natsCredentialProfile.deleteMany({ where: { id: { in: orphanIds } } });
  return orphanIds.length;
}

/**
 * Drop `NatsSigningKey` rows owned by this stack whose names aren't in
 * the freshly-rendered set. Removed rows take their public key out of the
 * next `applyConfig()` re-issued account JWT, which `updateAccountClaim()`
 * then propagates live. Vault KV cleanup is best-effort — a stale seed
 * blob is harmless once the public key is no longer in any account JWT.
 */
async function pruneOrphanSigningKeys(args: {
  prisma: PrismaClient;
  stackId: string;
  desiredSignerNames: Set<string>;
}): Promise<number> {
  const existing = await args.prisma.natsSigningKey.findMany({
    where: { stackId: args.stackId },
    select: { id: true, name: true, seedKvPath: true },
  });
  const orphans = existing.filter((row) => !args.desiredSignerNames.has(row.name));
  if (orphans.length === 0) return 0;
  await args.prisma.natsSigningKey.deleteMany({
    where: { id: { in: orphans.map((o) => o.id) } },
  });
  for (const orphan of orphans) {
    try {
      await getVaultKVService().delete(orphan.seedKvPath, { permanent: true });
    } catch (err) {
      getLogger("integrations", "nats-apply-orchestrator").warn(
        { err: err instanceof Error ? err.message : String(err), path: orphan.seedKvPath },
        "Best-effort Vault KV delete of orphan signer seed failed",
      );
    }
  }
  return orphans.length;
}

// =====================================================================
// Phase 5 helpers — cross-stack imports
// =====================================================================

/**
 * Resolve a single `imports[]` entry against a producer stack.
 *
 * Steps:
 *   1. Find producer stack by `fromStack` name (the design treats this as
 *      a structural reference; on a single-host system stack names are
 *      unique within an environment scope, and the design defers cross-
 *      environment imports to a future iteration).
 *   2. Verify producer is applied (has `lastAppliedAt` set + a snapshot).
 *   3. Read producer's resolved exports + subjectPrefix from its
 *      `lastAppliedNatsSnapshot`. Source of truth, not the template's raw
 *      authored exports — the snapshot reflects what's actually live.
 *   4. For each requested subject (relative to producer's prefix), build
 *      the absolute form `<producerPrefix>.<subject>`. Verify it matches
 *      one of the producer's exported patterns using NATS subject-match
 *      semantics (`>` = many tokens at end, `*` = exactly one token).
 *
 * Returns the absolute (producer-prefixed) subjects to add to subscribe
 * lists. Throws with a structured error if the producer is missing,
 * un-applied, or the import doesn't match any export.
 *
 * **Concurrency note.** This is a plain Prisma read; no global lock is
 * taken. If producer + consumer apply simultaneously, the consumer might
 * see an in-flight or stale snapshot. The design (§6) acknowledges this:
 * cross-stack apply contention is rare on a single-host system, and the
 * consumer's next apply will pick up any drift. A global NATS-apply lock
 * is the recommended hardening when contention is proven to matter.
 */
async function resolveImport(args: {
  prisma: PrismaClient;
  imp: TemplateNatsImport;
  consumerStackId: string;
  consumerEnvironmentId: string | null;
}): Promise<string[]> {
  if (args.imp.fromStack === "") {
    throw new Error(`NATS apply: imports[].fromStack is empty`);
  }
  // Scope the lookup to the consumer's environment. A host-scoped consumer
  // (`environmentId === null`) only sees host-scoped producers; an
  // environment-scoped consumer only sees stacks in the same environment.
  // Without this scope filter, two stacks with the same name (one host-
  // scoped, one in environment X) would resolve to whichever row Prisma's
  // default ordering picks — effectively random and a privilege-escalation
  // surface (a malicious stack named "events-bus" in one environment could
  // intercept imports targeting a host-level "events-bus").
  //
  // Cross-environment imports are explicitly out of scope for v1 per the
  // design's §2.1 ("Out of scope: cross-environment imports").
  //
  // TODO: detect circular import dependencies (A imports B imports A).
  // Currently the orchestrator allows ping-pong eventual consistency: each
  // apply uses the other's prior snapshot. Phase-5+ should add a cycle
  // check and refuse to apply, surfacing the cycle to the operator.
  const producer = await args.prisma.stack.findFirst({
    where: {
      name: args.imp.fromStack,
      removedAt: null,
      environmentId: args.consumerEnvironmentId,
    },
    select: {
      id: true,
      name: true,
      lastAppliedNatsSnapshot: true,
    },
  });
  if (!producer) {
    throw new Error(
      `NATS apply: imports[].fromStack '${args.imp.fromStack}' not found — apply the producer stack first`,
    );
  }
  if (producer.id === args.consumerStackId) {
    throw new Error(`NATS apply: imports[].fromStack cannot reference the consumer stack itself`);
  }
  // Source of truth is the NATS snapshot itself, not stack.lastAppliedAt — the
  // orchestrator only writes the snapshot, the reconciler sets lastAppliedAt
  // for the broader apply. A populated snapshot is sufficient to know the
  // producer's NATS phase ran successfully.
  if (!producer.lastAppliedNatsSnapshot) {
    throw new Error(
      `NATS apply: producer stack '${args.imp.fromStack}' has no applied NATS snapshot — apply it before importing`,
    );
  }

  let snapshot: { subjectPrefix?: string; resolvedExports?: string[] };
  try {
    snapshot = JSON.parse(producer.lastAppliedNatsSnapshot);
  } catch {
    throw new Error(
      `NATS apply: producer stack '${args.imp.fromStack}' has a corrupt NATS snapshot — re-apply the producer`,
    );
  }
  const producerPrefix = snapshot.subjectPrefix;
  const producerExports = snapshot.resolvedExports ?? [];
  if (!producerPrefix || producerExports.length === 0) {
    throw new Error(
      `NATS apply: producer stack '${args.imp.fromStack}' did not export any subjects in its last apply`,
    );
  }

  const resolved: string[] = [];
  for (const subject of args.imp.subjects) {
    const absolute = `${producerPrefix}.${subject}`;
    const matches = producerExports.some((pattern) => natsSubjectMatches(pattern, absolute));
    if (!matches) {
      throw new Error(
        `NATS apply: imports[].subjects '${subject}' does not match any export of producer '${args.imp.fromStack}' (exports: ${producerExports.join(", ")})`,
      );
    }
    resolved.push(absolute);
  }
  return resolved;
}

/**
 * NATS subject-pattern match. `*` matches exactly one token at any
 * position; `>` matches one-or-more tokens at the end (and only at the
 * end). Mirrors the server-side semantics so the consumer's import
 * is rejected pre-apply if the producer's export wouldn't actually
 * grant access at runtime.
 */
function natsSubjectMatches(pattern: string, subject: string): boolean {
  const pt = pattern.split(".");
  const st = subject.split(".");
  for (let i = 0; i < pt.length; i++) {
    const seg = pt[i];
    if (seg === ">") {
      // `>` is only valid at the end of the pattern. Treat anywhere else
      // as no-match defensively.
      return i === pt.length - 1 && st.length > i;
    }
    if (i >= st.length) return false;
    if (seg === "*") continue;
    if (seg !== st[i]) return false;
  }
  return pt.length === st.length;
}

// Exported for unit tests. Internal — the orchestrator's main entrypoint
// is `runStackNatsApplyPhase`.
export const __testing = { natsSubjectMatches };
