import type { PrismaClient } from "@prisma/client";
import type { ServiceApplyResult } from "@mini-infra/types";
import { servicesLogger } from "../../../lib/logger-factory";
import { registerPostgresServer } from "./register-postgres-server";

interface PostInstallContext {
  stackName: string;
  projectName: string;
  parameterValues: Record<string, string | number | boolean>;
  serviceResults: ServiceApplyResult[];
  triggeredBy?: string;
  prisma: PrismaClient;
}

type ActionHandler = (ctx: PostInstallContext) => Promise<void>;

/**
 * Registry mapping template names to their post-install action handlers.
 * Mirrors the postInstallActions declared in each template's template.json.
 */
const templateHandlers: Record<string, ActionHandler[]> = {
  postgres: [registerPostgresServer],
};

/**
 * Run post-install actions for the given template after a successful apply.
 * Failures are caught and logged — they never break the apply operation.
 */
export async function runPostInstallActions(
  templateName: string | undefined,
  ctx: PostInstallContext
): Promise<void> {
  if (!templateName) return;

  const handlers = templateHandlers[templateName];
  if (!handlers || handlers.length === 0) return;

  const log = servicesLogger().child({ operation: "post-install-actions", templateName, stackName: ctx.stackName });

  for (const handler of handlers) {
    try {
      await handler(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ handler: handler.name, error: message }, "Post-install action failed");
    }
  }
}
