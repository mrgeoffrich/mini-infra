/**
 * Source of truth for system policy HCL bodies. Imported by `vault-seed.ts`
 * (DB rows) and read back from the DB on bootstrap by `vault-admin-service.ts`.
 * Keeping the bodies here means a capability change lands in one place — the
 * seed re-applies it on next boot, and bootstrap re-publishes from the DB.
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

export const MINI_INFRA_OPERATOR_HCL = `# mini-infra-operator — userpass policy for the human operator logging into
# the Vault UI to inspect state and debug. Deliberately NOT admin-equivalent:
# all write paths are delegated to the mini-infra-admin AppRole via the Mini
# Infra API. If a human operator needs admin capability, grant them the
# vault:admin scope on Mini Infra and drive Vault through the UI there.

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
