import { getLogger } from "../../../lib/logger-factory";
import { vaultServicesReady, getVaultServices } from "../../vault/vault-services";
import type { PostInstallContext } from "./types";

const log = getLogger("stacks", "register-vault-address");

const VAULT_SERVICE_NAME = "vault";
const VAULT_PORT = 8200;

/**
 * After a vault stack apply, sync VaultState.address to match the running
 * container so the vault page and health watcher always use the correct URL.
 *
 * The address is derived from the stack's projectName and the fixed vault
 * service name — no need to parse template config.
 */
export async function registerVaultAddress(ctx: PostInstallContext): Promise<void> {
  const address = `http://${ctx.projectName}-${VAULT_SERVICE_NAME}:${VAULT_PORT}`;

  if (!vaultServicesReady()) {
    log.warn({ address }, "Vault services not ready — skipping address sync");
    return;
  }

  const { stateService, admin } = getVaultServices();

  await stateService.setAddress(address);
  await stateService.setStackId(ctx.stackId);

  // Keep the in-memory HTTP client in sync so the health watcher probes the
  // correct endpoint without requiring a server restart.
  admin.useClient(address);

  log.info({ address, stackId: ctx.stackId }, "Vault address synced after stack apply");
}
