-- Data migration: update existing deployment-sourced rows before dropping columns
UPDATE "haproxy_backends" SET "sourceType" = 'manual' WHERE "sourceType" = 'deployment';
UPDATE "haproxy_routes" SET "sourceType" = 'manual' WHERE "sourceType" = 'deployment';
UPDATE "haproxy_frontends" SET "frontendType" = 'shared' WHERE "frontendType" = 'deployment';

-- Drop FK columns from HAProxy tables
-- HAProxyFrontend: drop deploymentConfigId (unique index + column)
DROP INDEX IF EXISTS "haproxy_frontends_deploymentConfigId_key";
DROP INDEX IF EXISTS "haproxy_frontends_deploymentConfigId_idx";
ALTER TABLE "haproxy_frontends" DROP COLUMN IF EXISTS "deploymentConfigId";

-- HAProxyRoute: drop deploymentConfigId
ALTER TABLE "haproxy_routes" DROP COLUMN IF EXISTS "deploymentConfigId";

-- HAProxyBackend: drop deploymentConfigId (index + column)
DROP INDEX IF EXISTS "haproxy_backends_deploymentConfigId_idx";
ALTER TABLE "haproxy_backends" DROP COLUMN IF EXISTS "deploymentConfigId";

-- HAProxyServer: drop deploymentId
ALTER TABLE "haproxy_servers" DROP COLUMN IF EXISTS "deploymentId";

-- Update default for HAProxyFrontend.frontendType
-- (SQLite does not support ALTER COLUMN DEFAULT; the Prisma schema default handles new rows)

-- Drop deployment tables (order matters due to foreign keys)
DROP TABLE IF EXISTS "deployment_dns_records";
DROP TABLE IF EXISTS "deployment_steps";
DROP TABLE IF EXISTS "deployment_containers";
DROP TABLE IF EXISTS "deployments";
DROP TABLE IF EXISTS "deployment_configurations";
