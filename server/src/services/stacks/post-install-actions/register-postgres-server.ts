import type { PrismaClient } from "../../../generated/prisma/client";
import type { ServiceApplyResult } from "@mini-infra/types";
import { servicesLogger } from "../../../lib/logger-factory";

interface RegisterContext {
  stackName: string;
  projectName: string;
  parameterValues: Record<string, string | number | boolean>;
  serviceResults: ServiceApplyResult[];
  triggeredBy?: string;
  prisma: PrismaClient;
}

/**
 * After a successful postgres stack deploy, register the container as a managed
 * PostgresServer so it appears in the postgres server list and can be managed
 * from the UI. Skips silently if a server is already registered for this container.
 */
export async function registerPostgresServer(ctx: RegisterContext): Promise<void> {
  const log = servicesLogger().child({ action: "register-postgres-server", stackName: ctx.stackName });

  // Only register on successful create/recreate of the postgres service
  const postgresResult = ctx.serviceResults.find((r) => r.serviceName === "postgres");
  if (!postgresResult?.success || !postgresResult.containerId) {
    log.debug({ postgresResult }, "Skipping postgres server registration — service not created or no container ID");
    return;
  }

  const containerName = `${ctx.projectName}-postgres`;

  // Idempotency check: skip if already registered for this container name
  const existing = await ctx.prisma.postgresServer.findFirst({
    where: { linkedContainerName: containerName },
    select: { id: true },
  });
  if (existing) {
    log.debug({ containerName }, "PostgresServer already registered for this container, skipping");
    return;
  }

  // Only register for create/recreate actions (not no-op)
  if (postgresResult.action !== "create" && postgresResult.action !== "recreate") {
    log.debug({ action: postgresResult.action }, "Skipping postgres server registration — not a create/recreate action");
    return;
  }

  const user = String(ctx.parameterValues["postgres-user"] ?? "postgres");
  const password = String(ctx.parameterValues["postgres-password"] ?? "");
  const db = String(ctx.parameterValues["postgres-db"] ?? "postgres");

  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${containerName}:5432/${db}?sslmode=disable`;

  // userId is required on PostgresServer — use triggeredBy if available
  if (!ctx.triggeredBy) {
    log.warn("No triggeredBy user ID — cannot register PostgresServer (userId required)");
    return;
  }

  await ctx.prisma.postgresServer.create({
    data: {
      name: ctx.stackName,
      host: containerName,
      port: 5432,
      adminUsername: user,
      connectionString,
      sslMode: "disable",
      linkedContainerId: postgresResult.containerId,
      linkedContainerName: containerName,
      userId: ctx.triggeredBy,
    },
  });

  log.info({ containerName, stackName: ctx.stackName }, "Registered PostgresServer for postgres stack");
}
