-- Add poolConfig and vaultAppRoleId to stack_template_services so user-created
-- templates can round-trip Pool services and per-service Vault bindings.
-- Mirrors the equivalent columns on stack_services.

ALTER TABLE "stack_template_services" ADD COLUMN "poolConfig" JSONB;
ALTER TABLE "stack_template_services" ADD COLUMN "vaultAppRoleId" TEXT;
