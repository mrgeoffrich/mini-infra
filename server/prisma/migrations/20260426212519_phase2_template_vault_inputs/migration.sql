-- AlterTable
ALTER TABLE "stack_template_services" ADD COLUMN "vaultAppRoleRef" TEXT;

-- AlterTable
ALTER TABLE "stack_template_versions" ADD COLUMN "inputs" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "vaultAppRoles" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "vaultKv" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "vaultPolicies" JSONB;

-- AlterTable
ALTER TABLE "stacks" ADD COLUMN "encryptedInputValues" TEXT;
