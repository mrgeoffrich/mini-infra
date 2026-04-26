import crypto from "crypto";
import { PrismaClient } from "../../lib/prisma";
import { OperatorPassphraseService } from "../../lib/operator-passphrase-service";
import { VaultHttpClient } from "./vault-http-client";
import type { VaultAuthResponse } from "./vault-http-client";
import { VaultStateService } from "./vault-state-service";
import { getLogger } from "../../lib/logger-factory";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { OperationStep } from "@mini-infra/types";
import type { VaultBootstrapResult } from "@mini-infra/types";
// Single source of truth for the admin policy HCL. Imported by the seeder so
// the DB row, the bootstrap-time write, and the per-login self-heal all
// publish the same body — no drift when capabilities are added or removed.
import { MINI_INFRA_ADMIN_HCL } from "./vault-policy-bodies";

const log = getLogger("platform", "vault-admin-service");

/** Floor for renewal scheduling — never schedule sooner than 30 s. */
const MIN_RENEWAL_DELAY_MS = 30_000;
/** Default lease used when Vault doesn't return one (shouldn't happen, but). */
const DEFAULT_LEASE_SECONDS = 60 * 60;

export type StepCallback = (
  step: OperationStep,
  completedCount: number,
  totalSteps: number,
) => void;

const MINI_INFRA_ADMIN_POLICY_NAME = "mini-infra-admin";
const MINI_INFRA_OPERATOR_POLICY_NAME = "mini-infra-operator";
const MINI_INFRA_ADMIN_APPROLE_NAME = "mini-infra-admin";
const MINI_INFRA_OPERATOR_USERPASS_NAME = "mini-infra-operator";

const ADMIN_POLICY_HCL = MINI_INFRA_ADMIN_HCL;

const OPERATOR_POLICY_HCL = `# mini-infra-operator — userpass policy for human operator logging into the
# Vault UI to inspect state and debug. Deliberately NOT admin-equivalent: all
# write paths are delegated to the mini-infra-admin AppRole via the Mini Infra
# API. If a human operator needs admin capability, grant them the vault:admin
# scope on Mini Infra and drive Vault through the UI there.

# Read-only visibility into seal, mounts, policies, audit config
path "sys/health" { capabilities = ["read", "list"] }
path "sys/seal-status" { capabilities = ["read", "list"] }
path "sys/mounts" { capabilities = ["read", "list"] }
path "sys/mounts/*" { capabilities = ["read", "list"] }
path "sys/auth" { capabilities = ["read", "list"] }
path "sys/auth/*" { capabilities = ["read", "list"] }
path "sys/policies/acl" { capabilities = ["read", "list"] }
path "sys/policies/acl/*" { capabilities = ["read", "list"] }
path "sys/capabilities-self" { capabilities = ["update"] }

# List and read AppRoles to see which apps are configured
path "auth/approle/role" { capabilities = ["read", "list"] }
path "auth/approle/role/*" { capabilities = ["read", "list"] }

# Let the operator change their own userpass password. Others' passwords and
# new user creation are NOT allowed — use the admin AppRole via Mini Infra.
path "auth/userpass/users/mini-infra-operator/password" {
  capabilities = ["update"]
}

# Read and write secrets under secret/ — the operator needs this to debug
# what apps are reading at runtime. KV v2 requires both data/ and metadata/.
path "secret/data/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "secret/metadata/*" {
  capabilities = ["read", "list", "delete"]
}

# Token lifecycle for own session
path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
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
  private renewalTimer: NodeJS.Timeout | null = null;
  /**
   * Set while a `renew-self` request is in-flight or while
   * `authenticateAsAdmin` is logging in. Other token-mutating calls await
   * this so we never have two parallel auth flows mutating `adminToken`,
   * `client.token`, and the renewal timer at the same time.
   */
  private authInFlight: Promise<void> | null = null;

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
      () => completed,
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
      () => completed,
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
      () => completed,
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
      () => completed,
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
      () => completed,
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
      () => completed,
      () => ++completed,
      total,
    );

    // 7. Rotate root token — log in via the admin AppRole, confirm the admin
    //    token works, then revoke root. revokeSelf() revokes the token in the
    //    current X-Vault-Token header — we explicitly set it back to the root
    //    token for that call so that root is what gets revoked, then switch
    //    the client to use the admin token for all subsequent operations.
    await this.wrapStep(
      BOOTSTRAP_STEPS[6],
      async () => {
        const loginRes = await client.appRoleLogin(adminRoleId, adminSecretId);
        const adminToken = loginRes.auth.client_token;
        // Sanity check: the admin token can lookup itself. If this fails, root
        // is still alive and we abort before destroying the recovery path.
        client.setToken(adminToken);
        await client.lookupSelf();
        // Revoke root using root's own token.
        client.setToken(rootToken);
        await client.revokeSelf();
        await this.stateService.clearRootToken();
        // From here on the client uses the admin AppRole token. Routing the
        // login response through adoptAuthResponse also schedules the renewal.
        this.adoptAuthResponse(loginRes);
      },
      onStep,
      () => completed,
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
      () => completed,
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
      () => completed,
      () => ++completed,
      total,
    );
  }

  /**
   * Re-authenticate the in-memory admin token using stored AppRole credentials.
   * Called after restarts / passphrase unlocks so subsequent admin operations
   * (policy apply, AppRole management) have a live token.
   *
   * Serialised against any in-flight renewal so `adminToken` / `client.token`
   * never get clobbered by a racing `renewSelfTick`.
   */
  async authenticateAsAdmin(): Promise<void> {
    if (this.authInFlight) {
      await this.authInFlight;
      // If the in-flight op was a successful login/renewal, we now have a
      // live token and don't need to log in again.
      if (this.adminToken) return;
    }
    const op = this.authenticateAsAdminInner();
    this.authInFlight = op.then(
      () => undefined,
      () => undefined,
    );
    try {
      await op;
    } finally {
      this.authInFlight = null;
    }
  }

  private async authenticateAsAdminInner(): Promise<void> {
    if (!this.client) throw new Error("No Vault address configured");
    if (!this.passphrase.isUnlocked()) {
      throw new Error("Operator passphrase must be unlocked");
    }
    const roleId = await this.stateService.readAdminRoleId();
    const secretId = await this.stateService.readAdminSecretId();
    const res = await this.client.appRoleLogin(roleId, secretId);
    this.adoptAuthResponse(res);
    // Reconcile the admin policy with the source-of-truth HCL on every
    // successful login. Idempotent overwrite — keeps policy capabilities in
    // sync with the codebase even after upgrades that add new capabilities
    // (e.g. KV `patch` for the brokered Vault KV API).
    try {
      await this.client.writePolicy(MINI_INFRA_ADMIN_POLICY_NAME, ADMIN_POLICY_HCL);
    } catch (err) {
      // Non-fatal — apply will surface a clearer error if the policy is
      // missing capabilities. We still want the login to succeed so the
      // operator can investigate via the UI.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to refresh admin policy on login (non-fatal)",
      );
    }
  }

  hasAdminToken(): boolean {
    return this.adminToken !== null;
  }

  getAdminToken(): string | null {
    return this.adminToken;
  }

  /**
   * Returns a Vault client that's known-authenticated as the admin AppRole.
   * If the cached token is missing (e.g. dropped after a failed renewal),
   * attempts a fresh AppRole login once. Throws if the passphrase is locked
   * or the AppRole login fails.
   */
  async getAuthenticatedClient(): Promise<VaultHttpClient> {
    if (!this.client) throw new Error("No Vault address configured");
    if (!this.adminToken) {
      await this.authenticateAsAdmin();
    }
    return this.client;
  }

  /**
   * Cancel any scheduled renewal and drop the cached admin token. Call from
   * shutdown paths so the timer doesn't keep the process alive.
   */
  destroy(): void {
    this.cancelRenewalTimer();
    this.adminToken = null;
  }

  /**
   * Capture the freshly-issued auth response, store the token on the client,
   * and schedule the next renewal at half the lease.
   */
  private adoptAuthResponse(res: VaultAuthResponse): void {
    this.adminToken = res.auth.client_token;
    this.client?.setToken(this.adminToken);
    const leaseSeconds = res.auth.lease_duration ?? DEFAULT_LEASE_SECONDS;
    const renewable = res.auth.renewable !== false;
    if (!renewable) {
      log.warn(
        { leaseSeconds },
        "Admin token is not renewable; renewal loop disabled",
      );
      this.cancelRenewalTimer();
      return;
    }
    this.scheduleRenewal(leaseSeconds);
  }

  private scheduleRenewal(leaseSeconds: number): void {
    this.cancelRenewalTimer();
    const halfLeaseMs = Math.floor((leaseSeconds * 1000) / 2);
    const delayMs = Math.max(halfLeaseMs, MIN_RENEWAL_DELAY_MS);
    log.debug(
      { leaseSeconds, delayMs },
      "Scheduling vault admin token renewal",
    );
    this.renewalTimer = setTimeout(() => {
      void this.renewSelfTick();
    }, delayMs);
    // Don't keep the process alive on this timer alone.
    this.renewalTimer.unref?.();
  }

  private cancelRenewalTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  /**
   * Renew the cached admin token. On success, schedule the next renewal.
   * On failure, drop the cached token and emit a warning so operators can see
   * the degraded state instead of getting silent 500s on subsequent calls.
   *
   * Serialised against `authenticateAsAdmin` via `authInFlight`. If a manual
   * re-auth is already underway when the renewal timer fires, we wait for it
   * and then bail — the manual re-auth has already produced a fresh token
   * and scheduled the next renewal.
   */
  private async renewSelfTick(): Promise<void> {
    if (this.authInFlight) {
      await this.authInFlight;
      // The manual re-auth scheduled its own next renewal. Don't double up.
      return;
    }
    if (!this.client || !this.adminToken) {
      this.renewalTimer = null;
      return;
    }
    const op = this.renewSelfTickInner();
    this.authInFlight = op.then(
      () => undefined,
      () => undefined,
    );
    try {
      await op;
    } finally {
      this.authInFlight = null;
    }
  }

  private async renewSelfTickInner(): Promise<void> {
    if (!this.client || !this.adminToken) {
      this.renewalTimer = null;
      return;
    }
    try {
      const res = await this.client.renewSelf();
      const leaseSeconds =
        res.auth.lease_duration ?? DEFAULT_LEASE_SECONDS;
      log.debug({ leaseSeconds }, "Renewed vault admin token");
      this.scheduleRenewal(leaseSeconds);
      return;
    } catch (renewErr) {
      const detail = renewErr instanceof Error ? renewErr.message : String(renewErr);
      log.warn(
        { err: detail },
        "Vault admin token renewal failed; attempting AppRole re-login",
      );
      // Drop the stale token before re-auth so the AppRole login starts clean.
      this.adminToken = null;
      this.client.clearToken();
    }

    // Renewal failed — most often the token expired (Vault returns "permission
    // denied" for expired tokens, indistinguishable from a real ACL denial).
    // The AppRole credentials are persisted, so just log in again. If that
    // also fails (passphrase locked, AppRole revoked), drop into the
    // degenerate-state path below so callers get a clear error instead of
    // silent 500s on every subsequent admin op.
    try {
      await this.authenticateAsAdminInner();
      log.info(
        "Vault admin token re-issued via AppRole login after renewal failure",
      );
      return;
    } catch (loginErr) {
      const detail = loginErr instanceof Error ? loginErr.message : String(loginErr);
      log.warn(
        { err: detail },
        "Vault admin AppRole re-login failed; dropping cached token",
      );
      this.adminToken = null;
      this.client?.clearToken();
      this.cancelRenewalTimer();
      try {
        emitToChannel(Channel.VAULT, ServerEvent.VAULT_STATUS_CHANGED, {
          adminTokenStale: true,
          reason: detail,
        });
      } catch (emitErr) {
        log.debug({ err: emitErr }, "Failed to emit VAULT_STATUS_CHANGED");
      }
    }
  }

  private async wrapStep<T>(
    name: string,
    fn: () => Promise<T>,
    onStep: StepCallback | undefined,
    getCompleted: () => number,
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
      // Do NOT increment completed on failure — read the current value.
      const completed = getCompleted();
      safeStep(
        onStep,
        { step: name, status: "failed", detail },
        completed,
        totalSteps,
      );
      log.error({ err: detail, step: name }, "Vault bootstrap step failed");
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
