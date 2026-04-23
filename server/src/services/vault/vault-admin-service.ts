import crypto from "crypto";
import { PrismaClient } from "../../lib/prisma";
import { OperatorPassphraseService } from "../../lib/operator-passphrase-service";
import { VaultHttpClient, VaultHttpError } from "./vault-http-client";
import { VaultStateService } from "./vault-state-service";
import { getLogger } from "../../lib/logger-factory";
import type { OperationStep } from "@mini-infra/types";
import type { VaultBootstrapResult } from "@mini-infra/types";

const log = getLogger("platform", "vault-admin-service");

export type StepCallback = (
  step: OperationStep,
  completedCount: number,
  totalSteps: number,
) => void;

const MINI_INFRA_ADMIN_POLICY_NAME = "mini-infra-admin";
const MINI_INFRA_OPERATOR_POLICY_NAME = "mini-infra-operator";
const MINI_INFRA_ADMIN_APPROLE_NAME = "mini-infra-admin";
const MINI_INFRA_OPERATOR_USERPASS_NAME = "mini-infra-operator";

const ADMIN_POLICY_HCL = `# mini-infra-admin — managed by Mini Infra. Do not edit directly.
# Full administrative access used by Mini Infra's own admin AppRole.

path "sys/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "identity/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
`;

const OPERATOR_POLICY_HCL = `# mini-infra-operator — managed by Mini Infra.
# Used by the userpass mini-infra-operator account for human Vault UI access.

path "sys/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "identity/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
`;

const BOOTSTRAP_STEPS = [
  "Initialise Vault (sys/init)",
  "Persist and unseal with operator passphrase",
  "Enable auth methods (approle, userpass)",
  "Enable KV v2 at secret/",
  "Write mini-infra-admin policy + AppRole",
  "Write mini-infra-operator policy + userpass user",
  "Rotate root token",
] as const;

const UNSEAL_STEPS = ["Submit unseal shares", "Verify unsealed"] as const;

export interface BootstrapOptions {
  passphrase: string;
  address: string;
  stackId?: string;
  onStep?: StepCallback;
}

/**
 * Orchestrates Vault bootstrap, unseal, and root rotation.
 *
 * After bootstrap the in-memory HTTP client is switched from the root token
 * to the mini-infra-admin AppRole token for all subsequent operations.
 */
export class VaultAdminService {
  private adminToken: string | null = null;
  private client: VaultHttpClient | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly passphrase: OperatorPassphraseService,
    private readonly stateService: VaultStateService,
  ) {}

  /**
   * Set or replace the HTTP client (e.g. after the vault stack has been deployed
   * and its address is known).
   */
  useClient(address: string): VaultHttpClient {
    this.client = new VaultHttpClient(address);
    return this.client;
  }

  getClient(): VaultHttpClient | null {
    return this.client;
  }

  /**
   * Probe readiness. Returns `initialised` + `sealed` derived from sys/health.
   */
  async probe(): Promise<{
    reachable: boolean;
    initialised: boolean;
    sealed: boolean | null;
  }> {
    if (!this.client) {
      return { reachable: false, initialised: false, sealed: null };
    }
    const h = await this.client.health();
    if (!h) return { reachable: false, initialised: false, sealed: null };
    return {
      reachable: true,
      initialised: !!h.initialized,
      sealed: typeof h.sealed === "boolean" ? h.sealed : null,
    };
  }

  /**
   * First-time setup. Requires the operator passphrase to not yet be set.
   */
  async bootstrap(opts: BootstrapOptions): Promise<VaultBootstrapResult> {
    const onStep = opts.onStep;
    const total = BOOTSTRAP_STEPS.length;

    if (!this.client || this.client.addr !== opts.address) {
      this.useClient(opts.address);
    }
    const client = this.client!;

    if (await this.stateService.isBootstrapped()) {
      throw new Error("Vault is already bootstrapped");
    }

    // Passphrase-first: set it so subsequent state-service calls can wrap.
    await this.passphrase.setInitialPassphrase(opts.passphrase);
    await this.stateService.setAddress(opts.address);
    if (opts.stackId) await this.stateService.setStackId(opts.stackId);

    let completed = 0;

    // 1. sys/init
    const initRes = await this.wrapStep(
      BOOTSTRAP_STEPS[0],
      async () => client.init(3, 2),
      onStep,
      () => ++completed,
      total,
    );
    const unsealKeys = initRes.keys_base64 ?? initRes.keys;
    const rootToken = initRes.root_token;

    // 2. Persist wrapped state + unseal
    await this.wrapStep(
      BOOTSTRAP_STEPS[1],
      async () => {
        await this.stateService.persistInitResult({ unsealKeys, rootToken });
        client.setToken(rootToken);
        for (let i = 0; i < 2; i += 1) {
          await client.unsealSubmit(unsealKeys[i]);
        }
        const s = await client.sealStatus();
        if (s.sealed) {
          throw new Error("Vault is still sealed after submitting 2 shares");
        }
      },
      onStep,
      () => ++completed,
      total,
    );

    // 3. Enable auth methods
    await this.wrapStep(
      BOOTSTRAP_STEPS[2],
      async () => {
        await client.enableAuth("approle", "approle");
        await client.enableAuth("userpass", "userpass");
      },
      onStep,
      () => ++completed,
      total,
    );

    // 4. KV v2
    await this.wrapStep(
      BOOTSTRAP_STEPS[3],
      async () => {
        await client.enableKvV2("secret");
      },
      onStep,
      () => ++completed,
      total,
    );

    // 5. Admin policy + AppRole
    const { adminRoleId, adminSecretId } = await this.wrapStep(
      BOOTSTRAP_STEPS[4],
      async () => {
        await client.writePolicy(MINI_INFRA_ADMIN_POLICY_NAME, ADMIN_POLICY_HCL);
        await client.writeAppRole(MINI_INFRA_ADMIN_APPROLE_NAME, {
          token_policies: MINI_INFRA_ADMIN_POLICY_NAME,
          token_period: "1h",
          secret_id_num_uses: 0,
        });
        const roleId = await client.readAppRoleId(MINI_INFRA_ADMIN_APPROLE_NAME);
        const secretId = await client.mintAppRoleSecretId(
          MINI_INFRA_ADMIN_APPROLE_NAME,
        );
        await this.stateService.persistAdminAppRole(roleId, secretId);
        return { adminRoleId: roleId, adminSecretId: secretId };
      },
      onStep,
      () => ++completed,
      total,
    );

    // 6. Operator policy + userpass user
    const operatorPassword = generateRandomPassword();
    await this.wrapStep(
      BOOTSTRAP_STEPS[5],
      async () => {
        await client.writePolicy(
          MINI_INFRA_OPERATOR_POLICY_NAME,
          OPERATOR_POLICY_HCL,
        );
        await client.createUserpassUser(
          MINI_INFRA_OPERATOR_USERPASS_NAME,
          operatorPassword,
          [MINI_INFRA_OPERATOR_POLICY_NAME],
        );
        await this.stateService.persistOperatorPassword(operatorPassword);
      },
      onStep,
      () => ++completed,
      total,
    );

    // 7. Rotate root token — log in via admin AppRole, then revoke root
    await this.wrapStep(
      BOOTSTRAP_STEPS[6],
      async () => {
        const loginRes = await client.appRoleLogin(adminRoleId, adminSecretId);
        const adminToken = loginRes.auth.client_token;
        this.adminToken = adminToken;
        // Revoke root via the admin token so we don't burn it via revoke-self
        client.setToken(rootToken);
        await client.revokeSelf();
        client.setToken(adminToken);
        await this.stateService.clearRootToken();
      },
      onStep,
      () => ++completed,
      total,
    );

    await this.stateService.markBootstrapped();

    return {
      unsealKeys,
      unsealThreshold: 2,
      unsealShares: 3,
      rootToken,
      adminRoleId,
      adminSecretId,
      operatorUsername: MINI_INFRA_OPERATOR_USERPASS_NAME,
      operatorPassword,
    };
  }

  /**
   * Unseal a sealed but-already-initialised Vault using stored shares.
   * Requires operator passphrase to be unlocked.
   */
  async unseal(onStep?: StepCallback): Promise<void> {
    if (!this.client) throw new Error("No Vault address configured");
    if (!this.passphrase.isUnlocked()) {
      throw new Error("Operator passphrase must be unlocked before unseal");
    }
    const total = UNSEAL_STEPS.length;
    let completed = 0;
    const keys = await this.stateService.readUnsealKeys();
    await this.wrapStep(
      UNSEAL_STEPS[0],
      async () => {
        for (let i = 0; i < Math.min(2, keys.length); i += 1) {
          await this.client!.unsealSubmit(keys[i]);
        }
      },
      onStep,
      () => ++completed,
      total,
    );
    await this.wrapStep(
      UNSEAL_STEPS[1],
      async () => {
        const s = await this.client!.sealStatus();
        if (s.sealed) {
          throw new Error("Vault is still sealed after submitting shares");
        }
      },
      onStep,
      () => ++completed,
      total,
    );
  }

  /**
   * Re-authenticate the in-memory admin token using stored AppRole credentials.
   * Called after restarts / passphrase unlocks so subsequent admin operations
   * (policy apply, AppRole management) have a live token.
   */
  async authenticateAsAdmin(): Promise<void> {
    if (!this.client) throw new Error("No Vault address configured");
    if (!this.passphrase.isUnlocked()) {
      throw new Error("Operator passphrase must be unlocked");
    }
    const roleId = await this.stateService.readAdminRoleId();
    const secretId = await this.stateService.readAdminSecretId();
    const res = await this.client.appRoleLogin(roleId, secretId);
    this.adminToken = res.auth.client_token;
    this.client.setToken(this.adminToken);
  }

  hasAdminToken(): boolean {
    return this.adminToken !== null;
  }

  getAdminToken(): string | null {
    return this.adminToken;
  }

  private async wrapStep<T>(
    name: string,
    fn: () => Promise<T>,
    onStep: StepCallback | undefined,
    incrementCompleted: () => number,
    totalSteps: number,
  ): Promise<T> {
    try {
      const res = await fn();
      const completed = incrementCompleted();
      safeStep(onStep, { step: name, status: "completed" }, completed, totalSteps);
      return res;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Do NOT increment completed on failure
      const completed = Math.max(0, incrementCompleted() - 1);
      safeStep(
        onStep,
        { step: name, status: "failed", detail },
        completed,
        totalSteps,
      );
      log.error({ err: detail, step: name }, "Vault bootstrap step failed");
      if (err instanceof VaultHttpError) throw err;
      throw err;
    }
  }
}

function generateRandomPassword(): string {
  // 24 bytes → 32 base64url chars. Strong enough for a one-time operator cred.
  return crypto.randomBytes(24).toString("base64url");
}

function safeStep(
  cb: StepCallback | undefined,
  step: OperationStep,
  completed: number,
  total: number,
): void {
  if (!cb) return;
  try {
    cb(step, completed, total);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "onStep callback threw",
    );
  }
}

export const BOOTSTRAP_STEP_NAMES: readonly string[] = BOOTSTRAP_STEPS;
export const UNSEAL_STEP_NAMES: readonly string[] = UNSEAL_STEPS;
