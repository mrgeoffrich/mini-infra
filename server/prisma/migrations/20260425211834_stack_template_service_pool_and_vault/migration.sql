-- Add poolConfig and vaultAppRoleId to stack_template_services so user-created
-- templates can round-trip Pool services and per-service Vault bindings.
-- Mirrors the equivalent columns on stack_services. vaultAppRoleId carries a
-- proper FK + index so deleting a VaultAppRole nulls out template references
-- rather than leaving dangling string IDs.

ALTER TABLE "stack_template_services" ADD COLUMN "poolConfig" JSONB;
ALTER TABLE "stack_template_services" ADD COLUMN "vaultAppRoleId" TEXT REFERENCES "vault_app_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for FK lookups (cascade on VaultAppRole delete).
CREATE INDEX "stack_template_services_vaultAppRoleId_idx" ON "stack_template_services"("vaultAppRoleId");
