// Bootstraps the NATS operator/account NKey material in Vault and writes
// the rendered nats.conf body to a known KV path. The vault-nats stack
// template's NATS service consumes that conf via a `vault-kv` dynamicEnv
// entry, so the container always picks up the latest signed JWTs without
// needing a separate sidecar to materialise the file.
//
// Idempotent: once seeds exist in Vault, re-running re-renders the JWTs
// from the same seeds (which is cheap and lets us refresh the conf if
// rendering ever changes) but never rotates the operator. Rotating the
// operator would invalidate every user `.creds` file we've handed out.

import { getLogger } from "../../lib/logger-factory";
import { getVaultKVService } from "../vault/vault-kv-service";
import { VaultKVError } from "../vault/vault-kv-paths";
import {
  generateAccount,
  generateOperator,
  loadKeyPair,
  reissueAccountJwt,
  reissueOperatorJwt,
  mintUserCreds,
  type NatsPermissions,
} from "./nats-key-manager";
import { renderNatsConfig } from "./nats-config-renderer";
import { getNatsControlPlaneService } from "./nats-control-plane-service";

const log = getLogger("platform", "nats-bootstrap-service");

const OPERATOR_NAME = "mini-infra-operator";
const ACCOUNT_NAME = "mini-infra-account";

/** KV paths we own. */
export const NATS_OPERATOR_KV_PATH = "shared/nats-operator";
export const NATS_ACCOUNT_KV_PATH = "shared/nats-account";
export const NATS_CONFIG_KV_PATH = "shared/nats-config";

/** KV field names used at each path. Kept narrow to satisfy the validator
 *  in `services/stacks/schemas.ts` (`^[a-zA-Z0-9_-]+$`). */
const FIELD_OPERATOR_SEED = "operator_seed";
const FIELD_OPERATOR_JWT = "operator_jwt";
const FIELD_OPERATOR_PUBLIC = "operator_public";
const FIELD_ACCOUNT_SEED = "account_seed";
const FIELD_ACCOUNT_JWT = "account_jwt";
const FIELD_ACCOUNT_PUBLIC = "account_public";
const FIELD_CONFIG = "conf";

export interface NatsBootstrapResult {
  /** True when fresh seeds were generated this call. */
  generatedSeeds: boolean;
  operatorPublic: string;
  accountPublic: string;
}

/**
 * Idempotently ensure operator + account NKey material exist in Vault and
 * the rendered nats.conf is up-to-date. Safe to call from boot, after a
 * Vault unseal, or on demand — never rotates the operator/account seeds
 * once they exist.
 */
export class NatsBootstrapService {
  /**
   * Returns true on first successful call (after generating fresh seeds);
   * false on subsequent no-op calls. Always re-renders the conf so callers
   * picking up an updated `renderNatsConfig` get the new shape without
   * needing a manual KV write.
   */
  async bootstrap(): Promise<NatsBootstrapResult> {
    try {
      const managed = await getNatsControlPlaneService().applyConfig();
      if (managed.systemAccountPublic) {
        return {
          generatedSeeds: managed.generatedSeeds,
          operatorPublic: managed.operatorPublic,
          accountPublic: managed.systemAccountPublic,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("nats_accounts")) {
        throw err;
      }
      log.warn("NATS control-plane tables are unavailable; falling back to KV-only bootstrap");
    }

    const kv = getVaultKVService();

    let operatorSeed = await this.tryReadField(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED);
    let accountSeed = await this.tryReadField(NATS_ACCOUNT_KV_PATH, FIELD_ACCOUNT_SEED);

    let generatedSeeds = false;

    if (!operatorSeed) {
      log.info("Generating new NATS operator NKey");
      const op = await generateOperator(OPERATOR_NAME);
      await kv.write(NATS_OPERATOR_KV_PATH, {
        [FIELD_OPERATOR_SEED]: op.seed,
        [FIELD_OPERATOR_JWT]: op.jwt,
        [FIELD_OPERATOR_PUBLIC]: op.publicKey,
      });
      operatorSeed = op.seed;
      generatedSeeds = true;
    }

    const operatorKp = loadKeyPair(operatorSeed);
    const operatorMaterial = await reissueOperatorJwt(OPERATOR_NAME, operatorSeed);

    if (!accountSeed) {
      log.info("Generating new NATS account NKey");
      const acct = await generateAccount(ACCOUNT_NAME, operatorKp);
      await kv.write(NATS_ACCOUNT_KV_PATH, {
        [FIELD_ACCOUNT_SEED]: acct.seed,
        [FIELD_ACCOUNT_JWT]: acct.jwt,
        [FIELD_ACCOUNT_PUBLIC]: acct.publicKey,
      });
      accountSeed = acct.seed;
      generatedSeeds = true;
    }

    const accountMaterial = await reissueAccountJwt(
      ACCOUNT_NAME,
      accountSeed,
      operatorKp,
    );

    // Ensure account JWT/public key in Vault match what we just signed —
    // rendering uses these and the conf must reference the live values.
    await kv.write(NATS_ACCOUNT_KV_PATH, {
      [FIELD_ACCOUNT_SEED]: accountSeed,
      [FIELD_ACCOUNT_JWT]: accountMaterial.jwt,
      [FIELD_ACCOUNT_PUBLIC]: accountMaterial.publicKey,
    });
    await kv.write(NATS_OPERATOR_KV_PATH, {
      [FIELD_OPERATOR_SEED]: operatorSeed,
      [FIELD_OPERATOR_JWT]: operatorMaterial.jwt,
      [FIELD_OPERATOR_PUBLIC]: operatorMaterial.publicKey,
    });

    const conf = renderNatsConfig({
      operatorJwt: operatorMaterial.jwt,
      accountPublicKey: accountMaterial.publicKey,
      accountJwt: accountMaterial.jwt,
      jetStream: true,
    });
    await kv.write(NATS_CONFIG_KV_PATH, { [FIELD_CONFIG]: conf });

    log.info(
      {
        operatorPublic: operatorMaterial.publicKey,
        accountPublic: accountMaterial.publicKey,
        generatedSeeds,
      },
      "NATS bootstrap complete",
    );

    return {
      generatedSeeds,
      operatorPublic: operatorMaterial.publicKey,
      accountPublic: accountMaterial.publicKey,
    };
  }

  /**
   * Mint a user `.creds` string scoped to the supplied permissions. Caller
   * is responsible for storing or transporting the result — this method
   * does not persist the creds anywhere.
   */
  async mintCreds(
    userName: string,
    perms: NatsPermissions,
    ttlSeconds: number,
  ): Promise<string> {
    const accountSeed = await getVaultKVService().readField(
      NATS_ACCOUNT_KV_PATH,
      FIELD_ACCOUNT_SEED,
    );
    const accountKp = loadKeyPair(accountSeed);
    return mintUserCreds(userName, accountKp, perms, ttlSeconds);
  }

  private async tryReadField(path: string, field: string): Promise<string | null> {
    try {
      return await getVaultKVService().readField(path, field);
    } catch (err) {
      if (err instanceof VaultKVError) {
        if (err.code === "path_not_found" || err.code === "field_not_found") {
          return null;
        }
      }
      throw err;
    }
  }
}

let singleton: NatsBootstrapService | null = null;

export function getNatsBootstrapService(): NatsBootstrapService {
  if (!singleton) singleton = new NatsBootstrapService();
  return singleton;
}

/** Test-only reset. */
export function __resetNatsBootstrapServiceForTests(): void {
  singleton = null;
}
