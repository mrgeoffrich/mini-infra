import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import {
  MINI_INFRA_ADMIN_HCL,
  MINI_INFRA_OPERATOR_HCL,
} from "./vault-policy-bodies";

const log = getLogger("platform", "vault-seed");

/**
 * Seed built-in Vault policies. Called once at server boot — idempotent upsert.
 * System policies (`isSystem: true`) are auto-published to Vault during the
 * vault-nats stack bootstrap; user/example policies stay as drafts until an
 * operator edits and publishes them via the UI.
 */
export async function seedVaultPolicies(prisma: PrismaClient): Promise<void> {
  const policies: {
    name: string;
    displayName: string;
    description: string;
    draftHclBody: string;
    isSystem: boolean;
  }[] = [
    {
      name: "mini-infra-admin",
      displayName: "Mini Infra Admin",
      description:
        "Admin policy Mini Infra uses for platform-level Vault operations. Managed automatically — do not edit.",
      draftHclBody: MINI_INFRA_ADMIN_HCL,
      isSystem: true,
    },
    {
      name: "mini-infra-operator",
      displayName: "Mini Infra Operator (userpass)",
      description:
        "Policy for the userpass `mini-infra-operator` account used for human Vault UI access.",
      draftHclBody: MINI_INFRA_OPERATOR_HCL,
      isSystem: true,
    },
    {
      name: "user-self-service",
      displayName: "User Self-Service",
      description:
        "Example policy: lets a named user read/write their own secrets under secret/users/{{identity.entity.aliases.userpass.name}}/*.",
      draftHclBody: USER_SELF_SERVICE_HCL,
      isSystem: false,
    },
    {
      name: "read-only-example",
      displayName: "Read-Only (example)",
      description:
        "Example read-only policy scoped to secret/shared/*. Copy, rename, and customise.",
      draftHclBody: READ_ONLY_EXAMPLE_HCL,
      isSystem: false,
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
          isSystem: p.isSystem,
        },
        update: {
          displayName: p.displayName,
          description: p.description,
          // Re-assert isSystem on every boot so previously mis-flagged rows
          // (the two examples were originally seeded as isSystem: true) get
          // corrected on upgrade.
          isSystem: p.isSystem,
          // For system policies, keep draftHclBody pinned to the codebase
          // constant so capability changes (e.g. adding KV `patch`) flow
          // through to Vault on the next bootstrap. The HCL header tells
          // operators not to edit; update() in vault-policy-service also
          // blocks edits via the API. For user/example policies, preserve
          // any operator edits.
          ...(p.isSystem ? { draftHclBody: p.draftHclBody } : {}),
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
