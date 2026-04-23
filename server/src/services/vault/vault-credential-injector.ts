import type { PrismaClient } from "../../lib/prisma";
import type { StackContainerConfig, DynamicEnvSource } from "@mini-infra/types";
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
  /**
   * The AppRole ID bound to this stack on the last successful apply, if any.
   * If present and equals `appRoleId`, the binding is considered stable and
   * fail-closed degradation is allowed. If it differs, we always fail-closed.
   */
  prevBoundAppRoleId: string | null;
}

export interface InjectorResult {
  /** Env values to merge into the service's containerConfig.env. */
  values: Record<string, string>;
  /** True when the result is degraded (missing wrapped secret_id). */
  degraded: boolean;
}

/**
 * Resolves vault-backed dynamic env values at apply time.
 *
 * Strategy:
 *   - When Vault is reachable: reads role_id, mints a wrapped secret_id,
 *     returns full set.
 *   - When Vault is unreachable AND failClosed = true AND the stack's
 *     `vaultAppRoleId` matches its prior binding AND the AppRole has a
 *     cached role_id: returns role_id only (degraded). The running app can
 *     retry login-and-renew once Vault is back.
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
      return this.degradedOrThrow(args, roleId, vaultAddress, dynamicEnv, approle.cachedRoleId);
    }

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
      return this.degradedOrThrow(args, roleId, vaultAddress, dynamicEnv, approle.cachedRoleId);
    }

    return {
      values: buildValues(dynamicEnv, vaultAddress, roleId, wrappedSecretId),
      degraded: false,
    };
  }

  private degradedOrThrow(
    args: InjectorArgs,
    roleId: string | null,
    vaultAddress: string,
    dynamicEnv: Record<string, DynamicEnvSource>,
    cachedRoleId: string | null,
  ): InjectorResult {
    const { failClosed, prevBoundAppRoleId, appRoleId } = args;
    if (!failClosed) {
      return {
        values: buildValues(dynamicEnv, vaultAddress, roleId, undefined),
        degraded: true,
      };
    }
    // fail-closed: only degrade when the binding is stable AND the AppRole has
    // a known role_id (meaning it was successfully applied to Vault at least
    // once). A binding that changed since the last apply fails closed.
    const bindingStable = prevBoundAppRoleId === appRoleId && cachedRoleId !== null;
    if (bindingStable && roleId) {
      log.info(
        { approleId: appRoleId },
        "Vault unreachable; proceeding with role_id only (stable binding, cached role_id)",
      );
      return {
        values: buildValues(dynamicEnv, vaultAddress, roleId, undefined),
        degraded: true,
      };
    }
    throw new Error(
      "Vault is unreachable and this stack either has a new binding or no cached role_id; cannot apply in fail-closed mode",
    );
  }
}

function buildValues(
  dynamicEnv: Record<string, DynamicEnvSource>,
  vaultAddress: string,
  roleId: string | null,
  wrappedSecretId: string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, source] of Object.entries(dynamicEnv)) {
    switch (source.kind) {
      case "vault-addr":
        values[key] = vaultAddress;
        break;
      case "vault-role-id":
        if (roleId) values[key] = roleId;
        break;
      case "vault-wrapped-secret-id":
        if (wrappedSecretId) values[key] = wrappedSecretId;
        break;
    }
  }
  return values;
}

/**
 * When multiple dynamic-env entries specify a TTL, take the MIN — we must
 * satisfy the tightest bound. Falls back to the default when no entry
 * specifies one.
 */
function pickTtlSeconds(dynamicEnv: Record<string, DynamicEnvSource>): number {
  let ttl = DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS;
  let seen = false;
  for (const source of Object.values(dynamicEnv)) {
    if (source.kind === "vault-wrapped-secret-id" && source.ttlSeconds) {
      ttl = seen ? Math.min(ttl, source.ttlSeconds) : source.ttlSeconds;
      seen = true;
    }
  }
  return ttl;
}
