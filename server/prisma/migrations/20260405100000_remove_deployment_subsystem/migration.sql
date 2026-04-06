-- Data migration: update existing deployment-sourced rows before dropping columns
UPDATE "haproxy_backends" SET "sourceType" = 'manual' WHERE "sourceType" = 'deployment';
UPDATE "haproxy_routes" SET "sourceType" = 'manual' WHERE "sourceType" = 'deployment';
UPDATE "haproxy_frontends" SET "frontendType" = 'shared' WHERE "frontendType" = 'deployment';

-- Drop deployment tables FIRST (removes FK targets before we recreate haproxy_frontends)
DROP TABLE IF EXISTS "deployment_dns_records";
DROP TABLE IF EXISTS "deployment_steps";
DROP TABLE IF EXISTS "deployment_containers";
DROP TABLE IF EXISTS "deployments";
DROP TABLE IF EXISTS "deployment_configurations";

-- HAProxyFrontend: recreate table without deploymentConfigId column and its FK
-- SQLite cannot DROP COLUMN when the column has a foreign key constraint,
-- so we must use the table-recreation pattern.
CREATE TABLE "haproxy_frontends_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "frontendType" TEXT NOT NULL DEFAULT 'shared',
    "containerName" TEXT,
    "containerId" TEXT,
    "containerPort" INTEGER,
    "environmentId" TEXT,
    "frontendName" TEXT NOT NULL,
    "backendName" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "bindPort" INTEGER NOT NULL DEFAULT 80,
    "bindAddress" TEXT NOT NULL DEFAULT '*',
    "useSSL" BOOLEAN NOT NULL DEFAULT false,
    "tlsCertificateId" TEXT,
    "sslBindPort" INTEGER NOT NULL DEFAULT 443,
    "isSharedFrontend" BOOLEAN NOT NULL DEFAULT false,
    "sharedFrontendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_frontends_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "haproxy_frontends_tlsCertificateId_fkey" FOREIGN KEY ("tlsCertificateId") REFERENCES "tls_certificates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "haproxy_frontends_new" (
    "id", "frontendType", "containerName", "containerId", "containerPort",
    "environmentId", "frontendName", "backendName", "hostname",
    "bindPort", "bindAddress", "useSSL", "tlsCertificateId", "sslBindPort",
    "isSharedFrontend", "sharedFrontendId", "status", "errorMessage",
    "createdAt", "updatedAt"
)
SELECT
    "id", "frontendType", "containerName", "containerId", "containerPort",
    "environmentId", "frontendName", "backendName", "hostname",
    "bindPort", "bindAddress", "useSSL", "tlsCertificateId", "sslBindPort",
    "isSharedFrontend", "sharedFrontendId", "status", "errorMessage",
    "createdAt", "updatedAt"
FROM "haproxy_frontends";

DROP TABLE "haproxy_frontends";
ALTER TABLE "haproxy_frontends_new" RENAME TO "haproxy_frontends";

-- Recreate indexes for haproxy_frontends
CREATE UNIQUE INDEX "haproxy_frontends_frontendName_key" ON "haproxy_frontends"("frontendName");
CREATE INDEX "haproxy_frontends_frontendName_idx" ON "haproxy_frontends"("frontendName");
CREATE INDEX "haproxy_frontends_hostname_idx" ON "haproxy_frontends"("hostname");
CREATE INDEX "haproxy_frontends_status_idx" ON "haproxy_frontends"("status");
CREATE INDEX "haproxy_frontends_tlsCertificateId_idx" ON "haproxy_frontends"("tlsCertificateId");
CREATE INDEX "haproxy_frontends_frontendType_idx" ON "haproxy_frontends"("frontendType");
CREATE INDEX "haproxy_frontends_environmentId_idx" ON "haproxy_frontends"("environmentId");
CREATE INDEX "haproxy_frontends_isSharedFrontend_idx" ON "haproxy_frontends"("isSharedFrontend");

-- HAProxyRoute: drop deploymentConfigId (no FK constraint, safe to drop directly)
ALTER TABLE "haproxy_routes" DROP COLUMN "deploymentConfigId";

-- HAProxyBackend: drop deploymentConfigId (no FK constraint)
DROP INDEX IF EXISTS "haproxy_backends_deploymentConfigId_idx";
ALTER TABLE "haproxy_backends" DROP COLUMN "deploymentConfigId";

-- HAProxyServer: drop deploymentId (no FK constraint)
ALTER TABLE "haproxy_servers" DROP COLUMN "deploymentId";
