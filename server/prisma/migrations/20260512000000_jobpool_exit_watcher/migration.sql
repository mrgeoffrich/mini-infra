-- Phase 2 of the job-pool-service-type plan: the exit watcher needs two
-- nullable columns on `pool_instances` so a JobPool run row can carry the
-- container's exit code and the wall-clock time the run finalised. Pool rows
-- (the original Phase-1 use of this table) never set them.
--
-- The `status` column is still TEXT — Prisma renders the union as plain TEXT
-- in SQLite, so the new `completed`/`failed` statuses don't need a schema
-- change; only the application-side enum was widened.

ALTER TABLE "pool_instances" ADD COLUMN "exitCode" INTEGER;
ALTER TABLE "pool_instances" ADD COLUMN "finishedAt" DATETIME;
