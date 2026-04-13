import { ConfigurationService } from "../configuration-base";

export interface ManagedTunnelRecord {
  tunnelId: string;
  tunnelName: string;
  token: string | null;
  createdAt?: string;
}

export interface ManagedTunnelSummary {
  tunnelId: string;
  tunnelName: string;
  hasToken: boolean;
  createdAt?: string;
}

const KEY_PREFIX = "managed_tunnel_";
const SUFFIXES = ["id", "name", "token", "created_at"] as const;
type Suffix = (typeof SUFFIXES)[number];

/**
 * Encapsulates the `managed_tunnel_{id|name|token|created_at}_{envId}`
 * settings layout so the rest of the code stops concatenating keys by hand.
 */
export class ManagedTunnelStore {
  constructor(private readonly config: ConfigurationService) {}

  private key(suffix: Suffix, environmentId: string): string {
    return `${KEY_PREFIX}${suffix}_${environmentId}`;
  }

  async write(
    environmentId: string,
    record: Omit<ManagedTunnelRecord, "createdAt"> & { createdAt?: string },
    userId: string,
  ): Promise<void> {
    await this.config.set(this.key("id", environmentId), record.tunnelId, userId);
    await this.config.set(
      this.key("name", environmentId),
      record.tunnelName,
      userId,
    );
    if (record.token) {
      await this.config.set(
        this.key("token", environmentId),
        record.token,
        userId,
      );
    }
    await this.config.set(
      this.key("created_at", environmentId),
      record.createdAt ?? new Date().toISOString(),
      userId,
    );
  }

  async read(environmentId: string): Promise<ManagedTunnelSummary | null> {
    const tunnelId = await this.config.get(this.key("id", environmentId));
    if (!tunnelId) return null;

    const tunnelName =
      (await this.config.get(this.key("name", environmentId))) ?? "unknown";
    const token = await this.config.get(this.key("token", environmentId));
    const createdAt = await this.config.get(
      this.key("created_at", environmentId),
    );

    return {
      tunnelId,
      tunnelName,
      hasToken: !!token,
      createdAt: createdAt ?? undefined,
    };
  }

  async getTunnelId(environmentId: string): Promise<string | null> {
    return this.config.get(this.key("id", environmentId));
  }

  async getToken(environmentId: string): Promise<string | null> {
    return this.config.get(this.key("token", environmentId));
  }

  async clear(environmentId: string, userId: string): Promise<void> {
    for (const suffix of SUFFIXES) {
      try {
        await this.config.delete(this.key(suffix, environmentId), userId);
      } catch {
        // Missing keys are fine — best-effort cleanup.
      }
    }
  }

  /**
   * Enumerate every managed tunnel by finding rows with an `id` suffix.
   * Caller supplies a Prisma client because the underlying `findMany`
   * is not on the ConfigurationService surface.
   */
  async listAll(
    prismaSystemSettings: {
      findMany: (args: {
        where: { category: string; key: { startsWith: string } };
      }) => Promise<Array<{ key: string }>>;
    },
    category: string,
  ): Promise<Map<string, ManagedTunnelSummary>> {
    const result = new Map<string, ManagedTunnelSummary>();
    const idRows = await prismaSystemSettings.findMany({
      where: { category, key: { startsWith: `${KEY_PREFIX}id_` } },
    });

    for (const row of idRows) {
      const environmentId = row.key.replace(`${KEY_PREFIX}id_`, "");
      const info = await this.read(environmentId);
      if (info) {
        result.set(environmentId, info);
      }
    }

    return result;
  }
}
