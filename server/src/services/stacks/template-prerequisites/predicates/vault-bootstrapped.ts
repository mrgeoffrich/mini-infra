import { getLogger } from "../../../../lib/logger-factory";
import { getVaultServices, vaultServicesReady } from "../../../vault/vault-services";
import type { PredicateContext, PredicateResult } from "./types";

const log = getLogger("stacks", "vault-bootstrapped-predicate");

/**
 * Predicate: Vault is bootstrapped AND the operator passphrase is unlocked
 * in the running server. Returns ok only when both conditions hold —
 * `bootstrappedAt != null` proves the bootstrap flow has completed once,
 * and `passphrase.state === "unlocked"` proves the server can actually
 * read the wrapped secrets it needs to do work *right now*.
 *
 * The structural split exists because Vault state is persistent across
 * restarts (boostrappedAt) but the unlock state is per-process (operator
 * has to provide the passphrase after each cold start). A "bootstrapped
 * but locked" Vault is a real failure mode — the apply pipeline can't
 * mint AppRole tokens or write KV until the server has the unwrap key.
 */
export async function vaultBootstrappedPredicate(
  _ctx: PredicateContext,
): Promise<PredicateResult> {
  if (!vaultServicesReady()) {
    log.debug("Vault services not initialised — predicate fails");
    return {
      ok: false,
      reason: "Vault services not initialised",
    };
  }

  let bootstrappedAt: Date | null;
  let passphraseState: "uninitialised" | "locked" | "unlocked";
  try {
    const vault = getVaultServices();
    // VaultStateService.getMeta() returns the relevant subset (or null
    // when no row exists yet). We only need bootstrappedAt here.
    const meta = await vault.stateService.getMeta();
    bootstrappedAt = meta?.bootstrappedAt ?? null;
    passphraseState = vault.passphrase.getState();
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to read Vault state for prerequisite check",
    );
    return {
      ok: false,
      reason: "Failed to read Vault state",
    };
  }

  if (bootstrappedAt == null) {
    return {
      ok: false,
      reason: "Vault has not been bootstrapped yet",
      helpAction: { type: "open-vault-bootstrap" },
    };
  }

  if (passphraseState !== "unlocked") {
    return {
      ok: false,
      reason: "Vault passphrase is locked",
      helpAction: { type: "open-vault-bootstrap" },
    };
  }

  return { ok: true };
}
