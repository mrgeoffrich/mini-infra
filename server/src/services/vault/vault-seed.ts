import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { MINI_INFRA_ADMIN_HCL } from "./vault-policy-bodies";

const log = getLogger("platform", "vault-seed");

/**
 * Seed system Vault policies. Called once at server boot — idempotent upsert.
 * Only writes rows into the DB; actual write-to-Vault happens when an operator
 * presses "Publish" in the UI, or on first bootstrap for `mini-infra-admin`.
 */
export async function seedVaultPolicies(prisma: PrismaClient): Promise<void> {
  const policies: {
    name: string;
    displayName: string;
    description: string;
    draftHclBody: string;
  }[] = [
    {
      name: "mini-infra-admin",
      displayName: "Mini Infra Admin",
      description:
        "Admin policy Mini Infra uses for platform-level Vault operations. Managed automatically — do not edit.",
      draftHclBody: MINI_INFRA_ADMIN_HCL,
    },
    {
      name: "mini-infra-operator",
      displayName: "Mini Infra Operator (userpass)",
      description:
        "Policy for the userpass `mini-infra-operator` account used for human Vault UI access.",
      draftHclBody: MINI_INFRA_OPERATOR_HCL,
    },
    {
      name: "user-self-service",
      displayName: "User Self-Service",
      description:
        "Example policy: lets a named user read/write their own secrets under secret/users/{{identity.entity.aliases.userpass.name}}/*.",
      draftHclBody: USER_SELF_SERVICE_HCL,
    },
    {
      name: "read-only-example",
      displayName: "Read-Only (example)",
      description:
        "Example read-only policy scoped to secret/shared/*. Copy, rename, and customise.",
      draftHclBody: READ_ONLY_EXAMPLE_HCL,
    },
  ];

  for (const p of policies) {
    try {
      await prisma.vaultPolicy.upsert({
        where: { name: p.name },
        create: {
          name: p.name,
          displayName: p.displayName,
          description: p.description,
          draftHclBody: p.draftHclBody,
          isSystem: true,
        },
        update: {
          displayName: p.displayName,
          description: p.description,
          isSystem: true,
          // Do NOT overwrite draftHclBody on upgrade — operators may have edited it
        },
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), name: p.name },
        "Failed to seed vault policy (non-fatal)",
      );
    }
  }
  log.info({ count: policies.length }, "Vault policies seeded");
}

// MINI_INFRA_ADMIN_HCL imported from ./vault-policy-bodies — single source of
// truth shared with vault-admin-service.ts (bootstrap + per-login self-heal).

const MINI_INFRA_OPERATOR_HCL = `# mini-infra-operator — userpass human-operator access.
# Read-only visibility + secret management + change own password. Keep in sync
# with the policy installed during bootstrap in vault-admin-service.ts.

path "sys/health" { capabilities = ["read", "list"] }
path "sys/seal-status" { capabilities = ["read", "list"] }
path "sys/mounts" { capabilities = ["read", "list"] }
path "sys/mounts/*" { capabilities = ["read", "list"] }
path "sys/auth" { capabilities = ["read", "list"] }
path "sys/auth/*" { capabilities = ["read", "list"] }
path "sys/policies/acl" { capabilities = ["read", "list"] }
path "sys/policies/acl/*" { capabilities = ["read", "list"] }
path "sys/capabilities-self" { capabilities = ["update"] }

path "auth/approle/role" { capabilities = ["read", "list"] }
path "auth/approle/role/*" { capabilities = ["read", "list"] }

path "auth/userpass/users/mini-infra-operator/password" {
  capabilities = ["update"]
}

path "secret/data/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "secret/metadata/*" {
  capabilities = ["read", "list", "delete"]
}

path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
`;

const USER_SELF_SERVICE_HCL = `# User self-service — each authenticated user can manage their own secrets
# under secret/users/<username>/*.

path "secret/data/users/{{identity.entity.aliases.auth_userpass_xxxxxxxx.name}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "secret/metadata/users/{{identity.entity.aliases.auth_userpass_xxxxxxxx.name}}/*" {
  capabilities = ["read", "list", "delete"]
}
`;

const READ_ONLY_EXAMPLE_HCL = `# Read-only example — reads all secrets under secret/shared/*.
# Copy, rename, and constrain the path pattern for production use.

path "secret/data/shared/*" {
  capabilities = ["read", "list"]
}

path "secret/metadata/shared/*" {
  capabilities = ["read", "list"]
}
`;
