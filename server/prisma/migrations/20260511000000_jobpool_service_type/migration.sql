-- Phase 1 of the job-pool-service-type plan: add the `JobPool` branch of the
-- StackServiceType discriminated union and the `jobPoolConfig` column that
-- holds the JobPoolConfig blob for both authored stack services and template
-- versions. SQLite renders the Prisma enum as plain TEXT (no CHECK), so the
-- new variant only requires two ADD COLUMN statements — no table rebuild.
--
-- Nullable everywhere because every existing row predates the feature; the
-- column is only populated for services where `serviceType = 'JobPool'`.

ALTER TABLE "stack_services" ADD COLUMN "jobPoolConfig" JSONB;
ALTER TABLE "stack_template_services" ADD COLUMN "jobPoolConfig" JSONB;
