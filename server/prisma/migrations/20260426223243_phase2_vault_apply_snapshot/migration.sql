-- AlterTable
ALTER TABLE "stacks" ADD COLUMN "lastAppliedVaultSnapshot" JSONB;
ALTER TABLE "stacks" ADD COLUMN "lastFailureReason" TEXT;
