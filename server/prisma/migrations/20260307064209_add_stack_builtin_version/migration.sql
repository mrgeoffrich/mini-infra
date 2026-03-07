-- AlterTable
ALTER TABLE "stacks" ADD COLUMN "builtinVersion" INTEGER;

-- Backfill existing built-in stacks
UPDATE "stacks" SET "builtinVersion" = 1 WHERE name IN ('monitoring', 'haproxy');
