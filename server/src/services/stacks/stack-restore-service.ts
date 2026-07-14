/**
 * Restore a stack's definition from a `StackDefinition` snapshot.
 *
 * Two callers, one behaviour:
 *   - `POST /stacks/:id/revert-pending` — restore from `Stack.lastAppliedSnapshot`
 *     (discard unapplied edits: "undo what I just typed").
 *   - `POST /stacks/:id/history/:deploymentId/restore` — restore from a specific
 *     `StackDeployment.snapshot` (go back to a definition that worked: "undo what
 *     I deployed on Tuesday").
 *
 * They were one inline block in the revert route until history restore needed the
 * same logic. That mattered more than the usual DRY argument: the synthetic-sidecar
 * filter below is load-bearing and non-obvious, and a second hand-rolled copy of
 * this restore is exactly how it would have been lost.
 *
 * Restores the DEFINITION only — no containers are touched. The stack lands
 * `pending` (or `synced` when restoring the last-applied state, which by
 * definition already matches reality) and the operator applies.
 */
import { PrismaClient, Prisma } from "../../generated/prisma/client";
import type { StackDefinition } from "@mini-infra/types";
import { toServiceCreateInput } from "./utils";

export interface RestoreSnapshotOptions {
  /**
   * The status to land on. `synced` only when the restored definition is
   * provably what is running (revert-pending, restoring the last applied
   * snapshot). Restoring an OLDER deployment leaves the definition ahead of
   * reality, which is exactly what `pending` means — claiming `synced` there
   * would tell the operator their containers already match a definition they
   * have not applied.
   */
  status: "synced" | "pending";
  /**
   * Rewind `Stack.version` to this revision. Only meaningful for revert-pending,
   * where the restored definition IS `lastAppliedVersion`. A history restore is a
   * new, unapplied edit and must bump the version forward instead.
   */
  rewindToVersion?: number | null;
  /** Bump `Stack.version` by one (a history restore is a new definition edit). */
  bumpVersion?: number;
}

/**
 * Rewrite `stackId`'s definition from `snapshot`, inside one transaction.
 * Callers own the operation lock and the status emit.
 */
export async function restoreStackFromSnapshot(
  prisma: PrismaClient,
  stackId: string,
  snapshot: StackDefinition,
  options: RestoreSnapshotOptions,
): Promise<void> {
  const versionData =
    options.bumpVersion !== undefined
      ? { version: options.bumpVersion }
      : options.rewindToVersion != null
        ? { version: options.rewindToVersion }
        : {};

  await prisma.$transaction(async (tx) => {
    await tx.stackService.deleteMany({ where: { stackId } });
    await tx.stack.update({
      where: { id: stackId },
      data: {
        status: options.status,
        ...versionData,
        name: snapshot.name,
        description: snapshot.description ?? null,
        parameters: (snapshot.parameters ?? []) as unknown as Prisma.InputJsonValue,
        resourceOutputs: (snapshot.resourceOutputs ?? []) as unknown as Prisma.InputJsonValue,
        resourceInputs: (snapshot.resourceInputs ?? []) as unknown as Prisma.InputJsonValue,
        networks: (snapshot.networks ?? []) as unknown as Prisma.InputJsonValue,
        volumes: (snapshot.volumes ?? []) as unknown as Prisma.InputJsonValue,
        tlsCertificates: (snapshot.tlsCertificates ?? []) as unknown as Prisma.InputJsonValue,
        dnsRecords: (snapshot.dnsRecords ?? []) as unknown as Prisma.InputJsonValue,
        tunnelIngress: (snapshot.tunnelIngress ?? []) as unknown as Prisma.InputJsonValue,
        services: {
          // The snapshot holds the RENDERED service list, which includes
          // synthetic addon sidecars. Only authored services may be restored as
          // StackService rows — restoring synthetics would duplicate the sidecars
          // when the next apply re-expands addons.
          create: snapshot.services.filter((s) => !s.synthetic).map(toServiceCreateInput),
        },
      },
    });
  });
}

/** A snapshot Json column is only usable if it actually carries a service list. */
export function isUsableSnapshot(value: unknown): value is StackDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { services?: unknown }).services)
  );
}

/** How many restorable snapshots to keep per stack. */
export const SNAPSHOT_RETENTION = 20;

/**
 * Drop the stored definition from all but the newest `keep` snapshot-bearing
 * deployments of a stack.
 *
 * A snapshot is a whole stack definition, and a busy stack deploys often — left
 * unbounded this table would grow without limit for data nobody will restore
 * from. The deployment ROWS are kept (the history of what happened is the audit
 * trail and must not be rewritten); only the restorable payload is dropped, which
 * is what `hasSnapshot: false` then reports to the client.
 */
export async function pruneDeploymentSnapshots(
  prisma: PrismaClient,
  stackId: string,
  keep: number = SNAPSHOT_RETENTION,
): Promise<void> {
  const keepIds = await prisma.stackDeployment.findMany({
    where: { stackId, snapshot: { not: Prisma.DbNull } },
    orderBy: { createdAt: "desc" },
    take: keep,
    select: { id: true },
  });

  await prisma.stackDeployment.updateMany({
    where: {
      stackId,
      snapshot: { not: Prisma.DbNull },
      id: { notIn: keepIds.map((d) => d.id) },
    },
    data: { snapshot: Prisma.DbNull },
  });
}
