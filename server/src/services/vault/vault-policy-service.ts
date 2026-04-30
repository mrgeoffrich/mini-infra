import type { PrismaClient } from "../../lib/prisma";
import type {
  CreateVaultPolicyRequest,
  UpdateVaultPolicyRequest,
  VaultPolicyInfo,
} from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { VaultAdminService } from "./vault-admin-service";

const log = getLogger("platform", "vault-policy-service");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Thrown when the caller tries to remove a policy still referenced. */
export class PolicyInUseError extends Error {
  readonly appRoleNames: string[];
  constructor(appRoleNames: string[]) {
    super(
      `Cannot delete policy: referenced by ${appRoleNames.length} AppRole(s): ${appRoleNames.join(", ")}`,
    );
    this.name = "PolicyInUseError";
    this.appRoleNames = appRoleNames;
  }
}

/** Thrown when a caller tries to mutate a system-managed policy. */
export class SystemPolicyError extends Error {
  constructor(action: string) {
    super(`Cannot ${action} a system-managed Vault policy`);
    this.name = "SystemPolicyError";
  }
}

export class VaultPolicyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly admin: VaultAdminService,
  ) {}

  async list(): Promise<VaultPolicyInfo[]> {
    const rows = await this.prisma.vaultPolicy.findMany({
      orderBy: { name: "asc" },
    });
    return rows.map(toInfo);
  }

  async get(id: string): Promise<VaultPolicyInfo | null> {
    const row = await this.prisma.vaultPolicy.findUnique({ where: { id } });
    return row ? toInfo(row) : null;
  }

  async getByName(name: string): Promise<VaultPolicyInfo | null> {
    const row = await this.prisma.vaultPolicy.findUnique({ where: { name } });
    return row ? toInfo(row) : null;
  }

  async create(
    input: CreateVaultPolicyRequest,
    userId: string,
  ): Promise<VaultPolicyInfo> {
    validateName(input.name);
    const row = await this.prisma.vaultPolicy.create({
      data: {
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        draftHclBody: input.draftHclBody,
        isSystem: false,
        createdById: userId,
        updatedById: userId,
      },
    });
    return toInfo(row);
  }

  async update(
    id: string,
    input: UpdateVaultPolicyRequest,
    userId: string,
  ): Promise<VaultPolicyInfo> {
    const existing = await this.prisma.vaultPolicy.findUnique({ where: { id } });
    if (existing?.isSystem) {
      throw new SystemPolicyError("edit");
    }
    const row = await this.prisma.vaultPolicy.update({
      where: { id },
      data: {
        displayName: input.displayName,
        description: input.description,
        draftHclBody: input.draftHclBody,
        updatedById: userId,
      },
    });
    return toInfo(row);
  }

  async delete(id: string): Promise<void> {
    const approles = await this.prisma.vaultAppRole.findMany({
      where: { policyId: id },
      select: { name: true },
    });
    if (approles.length > 0) {
      throw new PolicyInUseError(approles.map((a) => a.name));
    }
    const policy = await this.prisma.vaultPolicy.findUnique({ where: { id } });
    if (!policy) return;
    if (policy.isSystem) {
      throw new SystemPolicyError("delete");
    }

    // Best-effort remove from Vault; continue on any failure. Use the
    // authenticated-client getter so we lazily re-login if the cached admin
    // token has been dropped (e.g. after a renewal failure).
    if (policy.publishedVersion > 0) {
      try {
        const client = await this.admin.getAuthenticatedClient();
        await client.deletePolicy(policy.name);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), policy: policy.name },
          "Failed to remove policy from Vault (continuing)",
        );
      }
    }
    await this.prisma.vaultPolicy.delete({ where: { id } });
  }

  /**
   * Publish the draft to Vault (PUT sys/policies/acl/<name>) and record the
   * published version.
   */
  async publish(id: string): Promise<VaultPolicyInfo> {
    const row = await this.prisma.vaultPolicy.findUnique({ where: { id } });
    if (!row) throw new Error(`Vault policy ${id} not found`);
    if (!row.draftHclBody) {
      throw new Error("Policy has no draft HCL to publish");
    }
    // Use getAuthenticatedClient so we lazily re-login via the AppRole if the
    // cached admin token has been dropped — otherwise renewal-window glitches
    // surface as 500 "permission denied" until someone hits the manual
    // /admin/reauthenticate endpoint.
    const client = await this.admin.getAuthenticatedClient();
    await client.writePolicy(row.name, row.draftHclBody);
    const updated = await this.prisma.vaultPolicy.update({
      where: { id },
      data: {
        publishedHclBody: row.draftHclBody,
        publishedVersion: row.publishedVersion + 1,
        publishedAt: new Date(),
        lastAppliedAt: new Date(),
      },
    });
    log.info(
      { policy: row.name, version: updated.publishedVersion },
      "Vault policy published",
    );
    return toInfo(updated);
  }
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Vault policy name must be 3–64 lowercase alphanumeric or hyphen characters",
    );
  }
}

interface VaultPolicyRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  draftHclBody: string | null;
  publishedHclBody: string | null;
  publishedVersion: number;
  publishedAt: Date | null;
  lastAppliedAt: Date | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toInfo(r: VaultPolicyRow): VaultPolicyInfo {
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    draftHclBody: r.draftHclBody,
    publishedHclBody: r.publishedHclBody,
    publishedVersion: r.publishedVersion,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    lastAppliedAt: r.lastAppliedAt?.toISOString() ?? null,
    isSystem: r.isSystem,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
