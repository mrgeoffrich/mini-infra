import { getLogger } from "../../lib/logger-factory";
import { toServiceError } from "../../lib/service-error-mapper";
import { CloudflareApiRunner } from "./cloudflare-api-runner";
import { CloudflareTunnelApi } from "./cloudflare-tunnel-api";
import {
  ManagedTunnelStore,
  ManagedTunnelSummary,
} from "./managed-tunnel-store";

/**
 * Abstraction for the "managed tunnel" workflow: we own the tunnel on
 * Cloudflare, store the token locally, and tie it to a specific
 * environment. Creation is idempotent-by-design (rejects when a tunnel
 * already exists) and rolls back on failure.
 */
export class CloudflareManagedTunnels {
  constructor(
    private readonly runner: CloudflareApiRunner,
    private readonly tunnelApi: CloudflareTunnelApi,
    private readonly store: ManagedTunnelStore,
    private readonly prismaSystemSettings: {
      findMany: (args: {
        where: { category: string; key: { startsWith: string } };
      }) => Promise<Array<{ key: string }>>;
    },
    private readonly category: string,
  ) {}

  async create(
    environmentId: string,
    name: string,
    userId: string,
  ): Promise<{ tunnelId: string; tunnelName: string }> {
    const existingId = await this.store.getTunnelId(environmentId);
    if (existingId) {
      throw new Error(
        `A managed tunnel already exists for this environment (ID: ${existingId})`,
      );
    }

    let createdTunnelId: string | undefined;

    try {
      const { tunnelId, token } = await this.runner.run<{
        tunnelId: string;
        token: string;
      }>(
        { label: "managed tunnel create", logContext: { name } },
        async ({ cf, accountId }) => {
          const tunnelResponse = await cf.zeroTrust.tunnels.cloudflared.create({
            account_id: accountId,
            name,
            config_src: "cloudflare",
          });
          const newTunnelId = tunnelResponse.id;
          if (!newTunnelId) {
            throw new Error("Tunnel creation returned no ID");
          }
          createdTunnelId = newTunnelId;

          const token = (await cf.zeroTrust.tunnels.cloudflared.token.get(
            newTunnelId,
            { account_id: accountId },
          )) as unknown as string;
          if (!token) {
            throw new Error("Token retrieval returned empty token");
          }
          return { tunnelId: newTunnelId, token };
        },
      );

      // Best-effort default ingress config (catch-all 404).
      try {
        await this.tunnelApi.updateTunnelConfig(tunnelId, {
          ingress: [{ service: "http_status:404" }],
        });
      } catch (err) {
        getLogger("integrations", "cloudflare-managed-tunnel").warn(
          {
            tunnelId,
            error: err instanceof Error ? err.message : "Unknown",
          },
          "Failed to set default ingress config, continuing",
        );
      }

      await this.store.write(
        environmentId,
        { tunnelId, tunnelName: name, token },
        userId,
      );

      return { tunnelId, tunnelName: name };
    } catch (error) {
      if (createdTunnelId) {
        // Clean up a tunnel that was created but whose follow-up steps
        // failed, so the account doesn't accumulate orphan tunnels.
        try {
          await this.runner.run<void>(
            {
              label: "managed tunnel cleanup",
              logContext: { tunnelId: createdTunnelId },
            },
            async ({ cf, accountId }) => {
              await cf.zeroTrust.tunnels.cloudflared.delete(createdTunnelId!, {
                account_id: accountId,
              });
            },
          );
        } catch (cleanupErr) {
          getLogger("integrations", "cloudflare-managed-tunnel").error(
            {
              tunnelId: createdTunnelId,
              error:
                cleanupErr instanceof Error
                  ? cleanupErr.message
                  : "Unknown",
            },
            "Failed to clean up tunnel after error — manual cleanup may be required",
          );
        }
      }
      throw toServiceError(error, "cloudflare");
    }
  }

  async delete(environmentId: string, userId: string): Promise<void> {
    const tunnelId = await this.store.getTunnelId(environmentId);
    if (!tunnelId) {
      throw new Error("No managed tunnel exists for this environment");
    }

    // Best-effort remote delete — local settings are cleared either way
    // so the environment isn't stuck with a dangling reference.
    try {
      await this.runner.run<void>(
        { label: "managed tunnel delete", logContext: { tunnelId } },
        async ({ cf, accountId }) => {
          await cf.zeroTrust.tunnels.cloudflared.delete(tunnelId, {
            account_id: accountId,
          });
        },
      );
    } catch (error) {
      getLogger("integrations", "cloudflare-managed-tunnel").error(
        {
          tunnelId,
          error: error instanceof Error ? error.message : "Unknown",
        },
        "Failed to delete tunnel from Cloudflare — clearing local settings anyway",
      );
    }

    await this.store.clear(environmentId, userId);
  }

  async getInfo(environmentId: string): Promise<ManagedTunnelSummary | null> {
    return this.store.read(environmentId);
  }

  async getToken(environmentId: string): Promise<string | null> {
    return this.store.getToken(environmentId);
  }

  async getAll(): Promise<Map<string, ManagedTunnelSummary>> {
    try {
      return await this.store.listAll(this.prismaSystemSettings, this.category);
    } catch (error) {
      getLogger("integrations", "cloudflare-managed-tunnel").error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "Failed to get all managed tunnels",
      );
      return new Map();
    }
  }
}
