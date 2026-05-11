/**
 * Apply-time materialiser for the `pg-az-backup` JobPool template.
 *
 * Phase 4 (MINI-53) converts pg-az-backup from a bespoke executor + scheduler
 * into a JobPool service. The `BackupConfiguration` table keeps its existing
 * shape — one row per database — but cron schedules now flow into the
 * JobPool template's `triggers[]` rather than a hand-rolled `node-cron`
 * registry. This module is the bridge:
 *
 *   1. `materialiseTriggersForStack(stackId)` — given a pg-az-backup stack id,
 *      read every `BackupConfiguration` row whose database lives in this
 *      stack's environment (or, for the host-scoped fallback case, every
 *      enabled row), and write the derived triggers + maxConcurrent onto the
 *      stack's `pg-az-backup` JobPool service row. Then refresh the
 *      JobPoolCron/Nats registries so the change takes effect immediately.
 *
 *   2. `refreshAllPgBackupTriggers()` — boot-time backfill that walks every
 *      applied `pg-az-backup` stack and re-materialises its triggers. Picks
 *      up any `BackupConfiguration` row inserted between `code-task` runs.
 *
 * The module exports `installPgBackupRuntimeEnvResolver()` which registers a
 * wildcard runtime-env resolver against the JobPool spawner — every spawned
 * `pg-az-backup` run runs through it to mint the per-run `POSTGRES_*`,
 * `AZURE_SAS_URL`, etc. env (and to override `runId` with the freshly-created
 * `BackupOperation.id`).
 */

import type { PrismaClient } from "../../generated/prisma/client";
import type { JobPoolConfig, JobPoolTrigger, StackServiceDefinition } from "@mini-infra/types";
import { BackupSubject } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { JobPoolCronRegistry } from "../stacks/job-pool-cron-registry";
import { JobPoolNatsRegistry } from "../stacks/job-pool-nats-registry";
import {
  jobPoolRuntimeEnvResolvers,
  type JobPoolRuntimeEnvResolver,
} from "../stacks/job-pool-runtime-env-resolver";
import { PostgresDatabaseManager } from "../postgres";
import { StorageService } from "../storage/storage-service";
import { buildSidecarUploadEnv } from "./sidecar-env";

const log = getLogger("backup", "backup-job-pool-materialiser");

/** Service name the pg-az-backup template uses for its single JobPool service. */
export const PG_AZ_BACKUP_SERVICE_NAME = "pg-az-backup";
/** Template name on disk (`server/templates/pg-az-backup`). */
export const PG_AZ_BACKUP_TEMPLATE_NAME = "pg-az-backup";

/**
 * Tag (`name` field on `JobPoolTrigger`) used for the cron entry derived from
 * a single `BackupConfiguration` row. `cron-<databaseId>` is stable across
 * config edits and unique per database — the JobPoolCronRegistry uses the
 * triple `(stackId, serviceName, triggerName)` as its key.
 */
function cronTriggerNameForDatabase(databaseId: string): string {
  return `cron-${databaseId}`;
}

/**
 * Build the desired `triggers[]` for a single `pg-az-backup` JobPool service
 * from the `BackupConfiguration` rows that should drive it. Every scheduled
 * + enabled config produces one `cron` trigger; a single `nats-request`
 * trigger on `mini-infra.backup.run` is always emitted so the existing NATS
 * call sites (the manual route fallback, ad-hoc `nats request …` calls) keep
 * working.
 */
export function buildTriggersFromBackupConfigurations(
  configs: Array<{ databaseId: string; schedule: string | null; timezone: string; isEnabled: boolean }>,
): JobPoolTrigger[] {
  const triggers: JobPoolTrigger[] = [];
  for (const cfg of configs) {
    if (!cfg.schedule || !cfg.isEnabled) continue;
    triggers.push({
      kind: "cron",
      name: cronTriggerNameForDatabase(cfg.databaseId),
      schedule: cfg.schedule,
      timezone: cfg.timezone,
      // Structured authoring metadata — the runtime env resolver reads
      // `metadata.databaseId` first and only falls back to the
      // positional `cron-<id>` name-parse when an older materialised
      // trigger pre-dates this field (MINI-50 review finding M8). Using
      // `metadata` makes the convention explicit and means a hand-edit
      // or UI rename of `name` doesn't silently break resolution.
      metadata: { databaseId: cfg.databaseId },
    });
  }
  // Always-on NATS-request trigger replacing the bespoke executor's
  // `mini-infra.backup.run` responder. Keep the subject identical to the
  // pre-Phase-4 wire shape so ad-hoc `nats request mini-infra.backup.run …`
  // calls continue to work.
  triggers.push({
    kind: "nats-request",
    name: "nats-request",
    subject: BackupSubject.run,
    ackWithRunId: true,
  });
  return triggers;
}

/**
 * Re-materialise the `triggers[]` on the `pg-az-backup` JobPool service of a
 * given stack. Every enabled `BackupConfiguration` row produces one cron
 * trigger; a single `nats-request` trigger on `mini-infra.backup.run` is
 * always emitted. Refreshes both JobPool trigger registries on success so
 * the change takes effect immediately. Tolerates missing registries —
 * boot ordering can put the materialiser before they're constructed; the
 * per-registry boot-time `loadAll()` catches that case.
 */
export async function materialiseTriggersForStack(
  prisma: PrismaClient,
  stackId: string,
): Promise<{ triggerCount: number }> {
  // Locate the JobPool service row for this stack. Bail quietly if the stack
  // isn't a pg-az-backup stack — callers don't know whether a stack id
  // points at a backup stack and we want to be safe to call from generic
  // hooks like `BackupConfigurationManager.create`.
  const service = await prisma.stackService.findFirst({
    where: {
      stackId,
      serviceName: PG_AZ_BACKUP_SERVICE_NAME,
      serviceType: "JobPool",
    },
  });
  if (!service) {
    log.debug({ stackId }, "materialiseTriggersForStack: no pg-az-backup JobPool service on this stack");
    return { triggerCount: 0 };
  }

  // `PostgresDatabase` rows are not currently environment-scoped (no
  // `environmentId` column on the model — see prisma schema). For Phase 4
  // the JobPool template is environment-scoped because it inherits the
  // per-env egress network + proxy injection, but the source-of-truth
  // BackupConfiguration table is host-flat. We expose every enabled
  // BackupConfiguration row as a cron trigger on every applied pg-az-backup
  // stack and document the single-instance-per-host constraint in
  // pg-az-backup/CLAUDE.md — applying a second env-scoped pg-az-backup
  // stack would cause duplicate runs. A future ticket can add an
  // `environmentId` to `PostgresDatabase` and filter here; for now the
  // shape matches the legacy single-runner behavior.
  const configs = await prisma.backupConfiguration.findMany({
    select: { databaseId: true, schedule: true, timezone: true, isEnabled: true },
  });

  const triggers = buildTriggersFromBackupConfigurations(configs);

  // Merge with whatever was previously on jobPoolConfig — only `triggers`
  // changes here. `maxConcurrent`, `history`, `killAfterSeconds`,
  // `onFailure` stay as the template wrote them (or as a future admin UI
  // wrote them).
  const existing = (service.jobPoolConfig as unknown as JobPoolConfig | null) ?? {
    maxConcurrent: 2,
    managedBy: null,
    triggers: [],
    history: { retainDays: 30, maxBytes: "1GiB" },
    killAfterSeconds: 7200,
    onFailure: { retries: 0, backoff: "fixed" as const },
  };
  const nextConfig: JobPoolConfig = { ...existing, triggers };

  await prisma.stackService.update({
    where: { id: service.id },
    data: { jobPoolConfig: nextConfig as unknown as object },
  });

  // Best-effort refresh of the in-process registries. Boot ordering can leave
  // them unset; the per-registry `loadAll()` catches that case on next boot.
  await JobPoolCronRegistry.getInstance()
    ?.refresh(stackId)
    .catch((err) => {
      log.warn(
        { stackId, err: err instanceof Error ? err.message : String(err) },
        "JobPoolCronRegistry.refresh threw during materialise",
      );
    });
  await JobPoolNatsRegistry.getInstance()
    ?.refresh(stackId)
    .catch((err) => {
      log.warn(
        { stackId, err: err instanceof Error ? err.message : String(err) },
        "JobPoolNatsRegistry.refresh threw during materialise",
      );
    });

  log.info(
    {
      stackId,
      serviceId: service.id,
      cronTriggers: triggers.filter((t) => t.kind === "cron").length,
      natsTriggers: triggers.filter((t) => t.kind === "nats-request").length,
    },
    "Materialised pg-az-backup triggers from BackupConfiguration rows",
  );

  return { triggerCount: triggers.length };
}

/**
 * Walk every applied `pg-az-backup` stack and re-materialise its triggers.
 * Called from `server.ts` on boot and from
 * `BackupConfigurationManager.{create,update,delete}` after each mutation.
 * Cheap — one query per pg-az-backup stack, almost always one row.
 */
export async function refreshAllPgBackupTriggers(prisma: PrismaClient): Promise<void> {
  const services = await prisma.stackService.findMany({
    where: { serviceName: PG_AZ_BACKUP_SERVICE_NAME, serviceType: "JobPool" },
    select: { stackId: true },
    distinct: ["stackId"],
  });
  for (const { stackId } of services) {
    try {
      await materialiseTriggersForStack(prisma, stackId);
    } catch (err) {
      log.warn(
        { stackId, err: err instanceof Error ? err.message : String(err) },
        "refreshAllPgBackupTriggers: per-stack materialise failed (continuing)",
      );
    }
  }
}

/**
 * Build the per-run runtime env resolver for the pg-az-backup JobPool.
 *
 * Runs strictly **after** the framework has reserved a `PoolInstance` row
 * under `ctx.runId` (the atomic cap-check transaction in `runJobPool`), so
 * an over-cap loser never reaches this resolver and never creates a
 * `BackupOperation` row or mints a SAS handle (MINI-50 review finding H3).
 *
 * Behaviour:
 *   - Recover `databaseId` from (in priority order): `ctx.trigger.metadata.databaseId`
 *     for materialised cron triggers, `payload.databaseId` for nats-request
 *     and manual-route triggers, or the legacy positional `cron-<id>`
 *     name-parse for backwards compat with un-re-applied stacks.
 *   - Look up the BackupConfiguration, mint a fresh SAS upload handle,
 *     build the per-run env, and create the `BackupOperation` DB row with
 *     `id: ctx.runId` so the row's primary key matches the JobPool's
 *     PoolInstance.instanceId and the in-container progress events land
 *     on the same `mini-infra.backup.progress.<runId>` subject the UI
 *     already subscribes to.
 */
function buildPgBackupRuntimeEnvResolver(): JobPoolRuntimeEnvResolver {
  return async (prisma, _dockerExecutor, ctx) => {
    const triggerName = ctx.trigger.name;
    const triggerMetadata = ctx.trigger.metadata ?? {};
    const payload = (ctx.payload ?? {}) as {
      databaseId?: string;
      operationType?: "manual" | "scheduled";
      userId?: string;
    };

    // Derive databaseId. Precedence:
    //   1. trigger.metadata.databaseId — structured author-supplied (M8 fix).
    //      Set by `buildTriggersFromBackupConfigurations()` and survives
    //      any future operator-driven rename of trigger.name.
    //   2. payload.databaseId — for NATS-request and manual-route triggers.
    //   3. Positional `cron-<id>` name parse — backwards-compat for any
    //      pre-M8 materialised triggers that pre-date the metadata field
    //      and haven't been re-applied yet. Once the stack re-applies, the
    //      metadata path takes over and this branch is dead. Kept so the
    //      first apply after upgrade doesn't fail mid-cron-fire.
    let databaseId: string | undefined;
    let operationType: "manual" | "scheduled" = "manual";

    if (triggerMetadata.databaseId) {
      databaseId = triggerMetadata.databaseId;
      operationType = ctx.trigger.kind === "cron" ? "scheduled" : "manual";
    } else if (payload.databaseId) {
      databaseId = payload.databaseId;
      operationType = payload.operationType ?? "manual";
    } else if (ctx.trigger.kind === "cron" && triggerName.startsWith("cron-")) {
      databaseId = triggerName.slice("cron-".length);
      operationType = "scheduled";
    }

    if (!databaseId) {
      return { env: {}, error: "pg-az-backup runtime env resolver: missing databaseId (trigger.metadata, payload, or cron-<id> name)" };
    }

    const databaseConfigService = new PostgresDatabaseManager(prisma);
    const database = await databaseConfigService.getDatabaseById(databaseId);
    if (!database) {
      return { env: {}, error: `pg-az-backup runtime env resolver: database ${databaseId} not found` };
    }
    const backupConfig = await prisma.backupConfiguration.findUnique({
      where: { databaseId },
    });
    if (!backupConfig) {
      return {
        env: {},
        error: `pg-az-backup runtime env resolver: no BackupConfiguration for database ${databaseId}`,
      };
    }

    const connectionConfig = await databaseConfigService.getConnectionConfig(databaseId);

    // Storage handle — mint per-run so the SAS URL is short-lived. The TTL
    // matches the JobPool's `killAfterSeconds` default (7200s = 2h) plus 15
    // min margin to cover slow uploads.
    const storageBackend = await StorageService.getInstance(prisma).getActiveBackend();
    const ttlMinutes = Math.ceil(7200 / 60) + 15;

    // BackupOperation row — `id` is the framework-supplied `ctx.runId` so
    // the row primary key and the JobPool PoolInstance.instanceId share
    // one identifier. Pre-H3 the resolver created the row with cuid()
    // and asked the framework to override its runId after the fact —
    // but that ordering put expensive resource minting *before* the
    // atomic cap-check transaction, so cap-hit losers still committed
    // BackupOperation rows + SAS URLs (MINI-50 review finding H3). Now
    // the framework reserves the PoolInstance row first and hands the
    // committed runId to the resolver, so the row created here only
    // ever ships when the cap-check actually granted the slot.
    const operationId = ctx.runId;
    await prisma.backupOperation.create({
      data: {
        id: operationId,
        databaseId,
        operationType,
        status: "pending",
        progress: 0,
      },
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobName = `${databaseId}/${operationId}_${timestamp}.dump`;
    let uploadHandle;
    try {
      uploadHandle = await storageBackend.mintUploadHandle(
        { id: backupConfig.storageLocationId },
        blobName,
        ttlMinutes,
      );
    } catch (err) {
      // Mark the operation failed up front so the UI doesn't show a
      // perpetually-pending row.
      await prisma.backupOperation
        .update({
          where: { id: operationId },
          data: {
            status: "failed",
            errorMessage: `Failed to mint upload handle: ${err instanceof Error ? err.message : String(err)}`,
            completedAt: new Date(),
          },
        })
        .catch(() => {
          /* logged downstream */
        });
      return {
        env: {},
        error: `pg-az-backup runtime env resolver: failed to mint upload handle (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    const sidecarEnv = buildSidecarUploadEnv(uploadHandle);
    const env: Record<string, string> = {
      POSTGRES_HOST: connectionConfig.host,
      POSTGRES_PORT: String(connectionConfig.port),
      POSTGRES_USER: connectionConfig.username,
      POSTGRES_PASSWORD: connectionConfig.password,
      POSTGRES_DATABASE: connectionConfig.database,
      BACKUP_FORMAT: backupConfig.backupFormat,
      COMPRESSION_LEVEL: String(backupConfig.compressionLevel),
      BACKUP_OPERATION_ID: operationId,
      BACKUP_CONFIG_ID: backupConfig.id,
      BACKUP_DATABASE_ID: databaseId,
      BACKUP_STORAGE_LOCATION_ID: backupConfig.storageLocationId,
      BACKUP_BLOB_NAME: blobName,
      BACKUP_STORAGE_PROVIDER_ID: storageBackend.providerId,
    };
    // sidecarEnv has typed optional fields; collapse to plain strings only.
    for (const [key, value] of Object.entries(sidecarEnv)) {
      if (typeof value === "string") env[key] = value;
    }

    log.info(
      {
        databaseId,
        operationId,
        operationType,
        triggerKind: ctx.trigger.kind,
        triggerName: ctx.trigger.name,
        triggerMetadataSource: triggerMetadata.databaseId
          ? 'metadata'
          : payload.databaseId
          ? 'payload'
          : 'name-parse',
        blobName,
        providerId: storageBackend.providerId,
      },
      "pg-az-backup runtime env resolved",
    );

    return { env };
  };
}

let installed = false;

/**
 * Register the wildcard runtime env resolver against every applied
 * `pg-az-backup` JobPool service. Called once from server boot. Idempotent.
 */
export function installPgBackupRuntimeEnvResolver(): void {
  if (installed) return;
  jobPoolRuntimeEnvResolvers.register("*", PG_AZ_BACKUP_SERVICE_NAME, buildPgBackupRuntimeEnvResolver());
  installed = true;
  log.info("Installed pg-az-backup runtime env resolver (wildcard)");
}

/** Test-only — drops the global installed flag. Does NOT unregister the resolver. */
export function __resetInstalledForTests(): void {
  installed = false;
}

/**
 * Auto-instantiate a pg-az-backup stack in any environment that has at least
 * one BackupConfiguration row but no applied pg-az-backup stack yet. Looks up
 * the system template, creates the stack via prisma directly (matching the
 * synthetic-creation pattern used by `vault-bootstrap`), and runs the
 * trigger materialisation.
 *
 * Not wired up in this phase — adding stacks at boot needs apply-side hooks
 * to spawn the container. Phase 4 ships only the manual instantiation
 * (operator creates the stack via the UI/template catalog); a follow-up
 * issue auto-instantiates from BackupConfiguration rows. For now the
 * exported stub keeps the future hook discoverable.
 */
export function maybeAutoCreatePgBackupStacks(_prisma: PrismaClient): Promise<void> {
  // Reserved for the follow-up issue (see plan doc Phase 4 deferral note).
  return Promise.resolve();
}

/**
 * Pull the JobPool service definition off the in-memory template — used by
 * unit tests so they can mint a stack without going through file-loader.
 */
export function readPgBackupTemplateServiceDefinitionFromDisk(
  templates: Array<{ name: string; definition: { services: StackServiceDefinition[] } }>,
): StackServiceDefinition | null {
  const tpl = templates.find((t) => t.name === PG_AZ_BACKUP_TEMPLATE_NAME);
  if (!tpl) return null;
  return tpl.definition.services.find((s) => s.serviceName === PG_AZ_BACKUP_SERVICE_NAME) ?? null;
}
