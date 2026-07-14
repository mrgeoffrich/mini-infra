/**
 * One-shot backfill: normalise stored healthcheck durations to milliseconds.
 *
 * Milliseconds is the canonical unit for `StackContainerConfig.healthcheck`
 * (declared on the shared type in `lib/types/stacks.ts`). Before that was
 * pinned, writers disagreed: the authoring UIs stored milliseconds while the
 * built-in template JSONs stored seconds, and the container-create paths
 * multiplied everything by 1e9 as though it were all seconds. A UI-authored app
 * with a 30s interval therefore got a Docker interval of ~8.3 hours and its
 * healthcheck never ran.
 *
 * This walks every column that can hold a healthcheck and scales the legacy
 * seconds values up. It is idempotent — the magnitude heuristic in
 * `normaliseHealthcheckToMs()` only scales values below the threshold, and a
 * scaled value lands above it — so it is safe to run on every boot, which is
 * how it is wired (see server.ts, alongside the network membership backfill).
 *
 * Columns covered:
 *   - StackService.containerConfig         (live per-stack services)
 *   - StackTemplateService.containerConfig (template versions)
 *   - Stack.lastAppliedSnapshot            (snapshot of services at apply time)
 *
 * The snapshot matters as much as the live rows: drift detection compares the
 * running container against it, so leaving stale seconds there would make every
 * converted stack read as drifted.
 */
import type { Logger } from "pino";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { normaliseHealthcheckToMs, type HealthcheckConversion } from "./healthcheck-config";

export interface HealthcheckBackfillResult {
  stackServices: number;
  templateServices: number;
  snapshots: number;
  conversions: number;
}

/** A containerConfig-shaped blob, as it comes back out of a Json column. */
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise the healthcheck on a single containerConfig blob.
 * Returns the rewritten config, or null when nothing changed.
 */
function normaliseContainerConfig(
  containerConfig: unknown,
): { config: JsonObject; conversions: HealthcheckConversion[] } | null {
  if (!isObject(containerConfig)) return null;

  const healthcheck = containerConfig.healthcheck;
  if (!isObject(healthcheck)) return null;

  const result = normaliseHealthcheckToMs(healthcheck);
  if (!result) return null;

  return {
    config: { ...containerConfig, healthcheck: result.healthcheck },
    conversions: result.conversions,
  };
}

function describe(conversions: HealthcheckConversion[]): string {
  return conversions.map((c) => `${c.key} ${c.from}→${c.to}`).join(", ");
}

/**
 * Cross the Prisma Json boundary. Same cast the snapshot's own builder uses —
 * see buildAppliedSnapshot() in stack-applied-snapshot.ts.
 */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export async function backfillHealthcheckUnits(
  prisma: PrismaClient,
  logger: Logger,
): Promise<HealthcheckBackfillResult> {
  const result: HealthcheckBackfillResult = {
    stackServices: 0,
    templateServices: 0,
    snapshots: 0,
    conversions: 0,
  };

  // --- live stack services -------------------------------------------------
  const stackServices = await prisma.stackService.findMany({
    select: { id: true, serviceName: true, containerConfig: true, stackId: true },
  });
  for (const svc of stackServices) {
    const normalised = normaliseContainerConfig(svc.containerConfig);
    if (!normalised) continue;

    await prisma.stackService.update({
      where: { id: svc.id },
      data: { containerConfig: asJson(normalised.config) },
    });
    result.stackServices += 1;
    result.conversions += normalised.conversions.length;
    logger.info(
      { stackId: svc.stackId, serviceName: svc.serviceName, conversions: normalised.conversions },
      `healthcheck units: stack service ${svc.serviceName} — ${describe(normalised.conversions)}`,
    );
  }

  // --- template services ---------------------------------------------------
  const templateServices = await prisma.stackTemplateService.findMany({
    select: { id: true, serviceName: true, containerConfig: true, versionId: true },
  });
  for (const svc of templateServices) {
    const normalised = normaliseContainerConfig(svc.containerConfig);
    if (!normalised) continue;

    await prisma.stackTemplateService.update({
      where: { id: svc.id },
      data: { containerConfig: asJson(normalised.config) },
    });
    result.templateServices += 1;
    result.conversions += normalised.conversions.length;
    logger.info(
      { versionId: svc.versionId, serviceName: svc.serviceName, conversions: normalised.conversions },
      `healthcheck units: template service ${svc.serviceName} — ${describe(normalised.conversions)}`,
    );
  }

  // --- last-applied snapshots ----------------------------------------------
  // The snapshot embeds a copy of every service definition, so it carries its
  // own copy of the stale units. Drift compares against this, so it has to move
  // in lockstep with the live rows above.
  const stacks = await prisma.stack.findMany({
    where: { lastAppliedSnapshot: { not: Prisma.DbNull } },
    select: { id: true, name: true, lastAppliedSnapshot: true },
  });
  for (const stack of stacks) {
    const snapshot = stack.lastAppliedSnapshot;
    if (!isObject(snapshot) || !Array.isArray(snapshot.services)) continue;

    const conversions: HealthcheckConversion[] = [];
    const services = snapshot.services.map((svc: unknown) => {
      if (!isObject(svc)) return svc;
      const normalised = normaliseContainerConfig(svc.containerConfig);
      if (!normalised) return svc;
      conversions.push(...normalised.conversions);
      return { ...svc, containerConfig: normalised.config };
    });

    if (conversions.length === 0) continue;

    await prisma.stack.update({
      where: { id: stack.id },
      data: { lastAppliedSnapshot: asJson({ ...snapshot, services }) },
    });
    result.snapshots += 1;
    result.conversions += conversions.length;
    logger.info(
      { stackId: stack.id, stackName: stack.name, conversions },
      `healthcheck units: snapshot for ${stack.name} — ${describe(conversions)}`,
    );
  }

  if (result.conversions > 0) {
    logger.info(
      result,
      `healthcheck units: normalised ${result.conversions} duration(s) to milliseconds ` +
        `across ${result.stackServices} stack service(s), ${result.templateServices} template ` +
        `service(s), ${result.snapshots} snapshot(s)`,
    );
  }

  return result;
}
