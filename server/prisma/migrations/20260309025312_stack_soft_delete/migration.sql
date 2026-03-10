-- DropIndex
DROP INDEX "stacks_name_environmentId_key";

-- AlterTable
ALTER TABLE "stacks" ADD COLUMN "removedAt" DATETIME;
