import type { PrismaClient } from "../../lib/prisma";
import type {
  CreateVaultAppRoleRequest,
  UpdateVaultAppRoleRequest,
  VaultAppRoleInfo,
} from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { VaultAdminService } from "./vault-admin-service";

const log = getLogger("platform", "vault-approle-service");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export class VaultAppRoleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly admin: VaultAdminService,
  ) {}

  async list(): Promise<VaultAppRoleInfo[]> {
    const rows = await this.prisma.vaultAppRole.findMany({
      include: { policy: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => toInfo(r, r.policy.name));
  }

  async get(id: string): Promise<VaultAppRoleInfo | null> {
    const row = await this.prisma.vaultAppRole.findUnique({
      where: { id },
      include: { policy: { select: { name: true } } },
    });
    return row ? toInfo(row, row.policy.name) : null;
  }

  async create(
    input: CreateVaultAppRoleRequest,
    userId: string,
  ): Promise<VaultAppRoleInfo> {
    validateName(input.name);
    const policy = await this.prisma.vaultPolicy.findUnique({
      where: { id: input.policyId },
    });
    if (!policy) {
      throw new Error(`Vault policy ${input.policyId} not found`);
    }
    const row = await this.prisma.vaultAppRole.create({
      data: {
        name: input.name,
        policyId: input.policyId,
        secretIdNumUses: input.secretIdNumUses ?? 1,
        secretIdTtl: input.secretIdTtl ?? "0",
        tokenTtl: input.tokenTtl,
        tokenMaxTtl: input.tokenMaxTtl,
        tokenPeriod: input.tokenPeriod,
        createdById: userId,
      },
    });
    return toInfo(row, policy.name);
  }

  async update(
    id: string,
    input: UpdateVaultAppRoleRequest,
  ): Promise<VaultAppRoleInfo> {
    if (input.policyId) {
      const policy = await this.prisma.vaultPolicy.findUnique({
        where: { id: input.policyId },
      });
      if (!policy) {
        throw new Error(`Vault policy ${input.policyId} not found`);
      }
    }
    const row = await this.prisma.vaultAppRole.update({
      where: { id },
      data: {
        policyId: input.policyId,
        secretIdNumUses: input.secretIdNumUses,
        secretIdTtl: input.secretIdTtl,
        tokenTtl: input.tokenTtl,
        tokenMaxTtl: input.tokenMaxTtl,
        tokenPeriod: input.tokenPeriod,
      },
      include: { policy: { select: { name: true } } },
    });
    return toInfo(row, row.policy.name);
  }

  async delete(id: string): Promise<void> {
    // Disallow if any stack is bound to this AppRole.
    const stacks = await this.prisma.stack.count({
      where: { vaultAppRoleId: id },
    });
    if (stacks > 0) {
      throw new Error(
        `Cannot delete AppRole: ${stacks} stack(s) are bound to it. Unbind them first.`,
      );
    }
    const row = await this.prisma.vaultAppRole.findUnique({ where: { id } });
    if (!row) return;
    const client = this.admin.getClient();
    if (client && row.lastAppliedAt) {
      try {
        await client.deleteAppRole(row.name);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), approle: row.name },
          "Failed to remove AppRole from Vault (continuing)",
        );
      }
    }
    await this.prisma.vaultAppRole.delete({ where: { id } });
  }

  /**
   * Write the AppRole config to Vault and capture the resulting role_id.
   */
  async apply(id: string): Promise<VaultAppRoleInfo> {
    const row = await this.prisma.vaultAppRole.findUnique({
      where: { id },
      include: { policy: { select: { name: true } } },
    });
    if (!row) throw new Error(`Vault AppRole ${id} not found`);
    const client = this.admin.getClient();
    if (!client) {
      throw new Error("Vault client is not configured; bootstrap required");
    }
    const config: Record<string, unknown> = {
      token_policies: row.policy.name,
      secret_id_num_uses: row.secretIdNumUses,
      secret_id_ttl: row.secretIdTtl,
    };
    if (row.tokenTtl) config.token_ttl = row.tokenTtl;
    if (row.tokenMaxTtl) config.token_max_ttl = row.tokenMaxTtl;
    if (row.tokenPeriod) config.token_period = row.tokenPeriod;

    await client.writeAppRole(row.name, config);
    const roleId = await client.readAppRoleId(row.name);
    const updated = await this.prisma.vaultAppRole.update({
      where: { id },
      data: { cachedRoleId: roleId, lastAppliedAt: new Date() },
      include: { policy: { select: { name: true } } },
    });
    log.info({ approle: row.name, roleId }, "Vault AppRole applied");
    return toInfo(updated, updated.policy.name);
  }

  /** Return boundlist of Stack IDs + names for a specific AppRole. */
  async listBoundStacks(id: string): Promise<{ id: string; name: string }[]> {
    const stacks = await this.prisma.stack.findMany({
      where: { vaultAppRoleId: id },
      select: { id: true, name: true },
    });
    return stacks;
  }
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Vault AppRole name must be 3–64 lowercase alphanumeric or hyphen characters",
    );
  }
}

interface VaultAppRoleRow {
  id: string;
  name: string;
  policyId: string;
  secretIdNumUses: number;
  secretIdTtl: string;
  tokenTtl: string | null;
  tokenMaxTtl: string | null;
  tokenPeriod: string | null;
  cachedRoleId: string | null;
  lastAppliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toInfo(r: VaultAppRoleRow, policyName: string): VaultAppRoleInfo {
  return {
    id: r.id,
    name: r.name,
    policyId: r.policyId,
    policyName,
    secretIdNumUses: r.secretIdNumUses,
    secretIdTtl: r.secretIdTtl,
    tokenTtl: r.tokenTtl,
    tokenMaxTtl: r.tokenMaxTtl,
    tokenPeriod: r.tokenPeriod,
    cachedRoleId: r.cachedRoleId,
    lastAppliedAt: r.lastAppliedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
