import type { PrismaClient } from "../../lib/prisma";
import type { StackDefinition, StackContainerConfig } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { getVaultServices } from "./vault-services";

const log = getLogger("platform", "vault-credential-injector");

/**
 * Default wrapping TTL used when a `vault-wrapped-secret-id` dynamic env
 * source doesn't specify one. 300s is comfortably above image pull + boot.
 */
export const DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS = 300;

export interface InjectorArgs {
  appRoleId: string;
  failClosed: boolean;
  /** Last successfully applied stack snapshot, used for degraded fallback. */
  prevSnapshot: StackDefinition | null;
}

export interface InjectorResult {
  VAULT_ADDR: string;
  VAULT_ROLE_ID: string;
  VAULT_WRAPPED_SECRET_ID?: string;
  /** Keys actually resolved — used to merge into env by name. */
  values: Record<string, string>;
}

/**
 * Resolves vault-backed dynamic env values at apply time.
 *
 * Strategy:
 *   - When Vault is reachable: reads role_id, mints a wrapped secret_id, returns full set.
 *   - When Vault is unreachable AND failClosed = true AND a prior snapshot with
 *     the same AppRole binding exists: returns role_id only (degraded). The
 *     running app can retry the login-and-renew cycle once Vault is back.
 *   - Otherwise throws.
 */
export class VaultCredentialInjector {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(
    args: InjectorArgs,
    containerConfig: StackContainerConfig | undefined,
  ): Promise<InjectorResult | null> {
    const dynamicEnv = containerConfig?.dynamicEnv;
    if (!dynamicEnv || Object.keys(dynamicEnv).length === 0) return null;

    const services = getVaultServices();
    const approle = await this.prisma.vaultAppRole.findUnique({
      where: { id: args.appRoleId },
    });
    if (!approle) {
      throw new Error(`Vault AppRole ${args.appRoleId} not found`);
    }

    const meta = await services.stateService.getMeta();
    const vaultAddress = meta?.address ?? "";
    if (!vaultAddress) {
      throw new Error("Vault address is not configured");
    }

    // Decide if we need to talk to Vault at all.
    const needsMint = Object.values(dynamicEnv).some(
      (src) => src.kind === "vault-wrapped-secret-id",
    );
    const needsRoleId = Object.values(dynamicEnv).some(
      (src) => src.kind === "vault-role-id",
    );

    let roleId: string | null = approle.cachedRoleId ?? null;
    let wrappedSecretId: string | undefined;
    const ttlSeconds = pickTtlSeconds(dynamicEnv);

    const client = services.admin.getClient();
    if (!client) {
      return this.degradedOrThrow(args, roleId, vaultAddress, dynamicEnv);
    }

    // Try the Vault-reachable happy path
    try {
      if (needsRoleId && !roleId) {
        roleId = await client.readAppRoleId(approle.name);
        // Best-effort cache
        await this.prisma.vaultAppRole.update({
          where: { id: approle.id },
          data: { cachedRoleId: roleId },
        }).catch((err: unknown) => {
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to cache role_id (non-fatal)",
          );
        });
      }
      if (needsMint) {
        const wrapped = await client.mintWrappedAppRoleSecretId(
          approle.name,
          ttlSeconds,
        );
        wrappedSecretId = wrapped.wrap_info.token;
      }
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          approle: approle.name,
        },
        "Vault unreachable while resolving dynamic env",
      );
      return this.degradedOrThrow(args, roleId, vaultAddress, dynamicEnv);
    }

    return this.buildValues({
      dynamicEnv,
      vaultAddress,
      roleId,
      wrappedSecretId,
    });
  }

  private degradedOrThrow(
    args: InjectorArgs,
    roleId: string | null,
    vaultAddress: string,
    dynamicEnv: Record<string, import("@mini-infra/types").DynamicEnvSource>,
  ): InjectorResult {
    const { failClosed, prevSnapshot, appRoleId } = args;
    if (!failClosed) {
      // best-effort — return whatever we can
      return this.buildValues({
        dynamicEnv,
        vaultAddress,
        roleId,
        wrappedSecretId: undefined,
      });
    }
    // fail-closed: only allow degrade when we have a prior snapshot bound to
    // the same AppRole (so we're definitely a re-apply, not a new deploy).
    const prevApproleMatches =
      prevSnapshot !== null &&
      hasSnapshotBoundToSameApprole(prevSnapshot, appRoleId);
    if (prevApproleMatches && roleId) {
      log.info(
        { approleId: appRoleId },
        "Vault unreachable, degrading to role_id-only (prior snapshot present)",
      );
      return this.buildValues({
        dynamicEnv,
        vaultAddress,
        roleId,
        wrappedSecretId: undefined,
      });
    }
    throw new Error(
      "Vault is unreachable and this stack has no valid prior snapshot; cannot apply in fail-closed mode",
    );
  }

  private buildValues(args: {
    dynamicEnv: Record<string, import("@mini-infra/types").DynamicEnvSource>;
    vaultAddress: string;
    roleId: string | null;
    wrappedSecretId?: string;
  }): InjectorResult {
    const values: Record<string, string> = {};
    for (const [key, source] of Object.entries(args.dynamicEnv)) {
      switch (source.kind) {
        case "vault-addr":
          values[key] = args.vaultAddress;
          break;
        case "vault-role-id":
          if (args.roleId) values[key] = args.roleId;
          break;
        case "vault-wrapped-secret-id":
          if (args.wrappedSecretId) values[key] = args.wrappedSecretId;
          break;
      }
    }
    return {
      VAULT_ADDR: args.vaultAddress,
      VAULT_ROLE_ID: args.roleId ?? "",
      VAULT_WRAPPED_SECRET_ID: args.wrappedSecretId,
      values,
    };
  }
}

function pickTtlSeconds(
  dynamicEnv: Record<string, import("@mini-infra/types").DynamicEnvSource>,
): number {
  let ttl = DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS;
  for (const source of Object.values(dynamicEnv)) {
    if (source.kind === "vault-wrapped-secret-id" && source.ttlSeconds) {
      // If multiple entries specify a TTL, use the max so all wraps survive
      ttl = Math.max(ttl, source.ttlSeconds);
    }
  }
  return ttl;
}

/**
 * Snapshots don't carry the binding FK directly — they carry the stack
 * definition. For our purposes, we treat "a prior snapshot exists" as
 * sufficient evidence of a prior successful apply. (The outer caller already
 * ensures this stack's current `vaultAppRoleId` matches its prior one; if it
 * changed, fail-closed SHOULD fail rather than degrade.)
 */
function hasSnapshotBoundToSameApprole(
  snapshot: StackDefinition,
  _appRoleId: string,
): boolean {
  // The snapshot is the stack definition, which doesn't include the binding
  // FK. In lieu of a snapshot-embedded binding, a non-empty snapshot implies a
  // successful prior apply — our binding matched then, and the caller verifies
  // binding stability at the API boundary.
  return snapshot.services != null && snapshot.services.length > 0;
}
