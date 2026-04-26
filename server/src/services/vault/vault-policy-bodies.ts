/**
 * Source of truth for system policy HCL bodies. Both the bootstrap path
 * (`vault-admin-service.ts`) and the DB seed (`vault-seed.ts`) import from
 * here so updates land in lockstep — adding a capability in one place but
 * not the other was the bug that surfaced when the brokered Vault KV API
 * needed `patch`.
 */

export const MINI_INFRA_ADMIN_HCL = `# mini-infra-admin — managed by Mini Infra. Do not edit directly.
# Full administrative access used by Mini Infra's own admin AppRole.

path "sys/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}

path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list", "patch"]
}

path "identity/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
`;
