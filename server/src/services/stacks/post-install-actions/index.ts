import { getLogger } from "../../../lib/logger-factory";
import { registerPostgresServer } from "./register-postgres-server";
import { registerVaultAddress } from "./register-vault-address";
import type { PostInstallContext } from "./types";

export type { PostInstallContext };

type ActionHandler = (ctx: PostInstallContext) => Promise<void>;

/**
 * Registry mapping template names to their post-install action handlers.
 * Mirrors the postInstallActions declared in each template's template.json.
 */
const templateHandlers: Record<string, ActionHandler[]> = {
  postgres: [registerPostgresServer],
  vault: [registerVaultAddress],
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

  const log = getLogger("stacks", "post-install-actions").child({ operation: "post-install-actions", templateName, stackName: ctx.stackName });

  for (const handler of handlers) {
    try {
      await handler(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ handler: handler.name, error: message }, "Post-install action failed");
    }
  }
}
