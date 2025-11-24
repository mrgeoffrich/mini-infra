-- CreateTable
CREATE TABLE "haproxy_routes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sharedFrontendId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "aclName" TEXT NOT NULL,
    "backendName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "deploymentConfigId" TEXT,
    "manualFrontendId" TEXT,
    "useSSL" BOOLEAN NOT NULL DEFAULT false,
    "tlsCertificateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_routes_sharedFrontendId_fkey" FOREIGN KEY ("sharedFrontendId") REFERENCES "haproxy_frontends" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_haproxy_frontends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentConfigId" TEXT,
    "frontendType" TEXT NOT NULL DEFAULT 'deployment',
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
    CONSTRAINT "haproxy_frontends_deploymentConfigId_fkey" FOREIGN KEY ("deploymentConfigId") REFERENCES "deployment_configurations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "haproxy_frontends_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "haproxy_frontends_tlsCertificateId_fkey" FOREIGN KEY ("tlsCertificateId") REFERENCES "tls_certificates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_haproxy_frontends" ("backendName", "bindAddress", "bindPort", "containerId", "containerName", "containerPort", "createdAt", "deploymentConfigId", "environmentId", "errorMessage", "frontendName", "frontendType", "hostname", "id", "sslBindPort", "status", "tlsCertificateId", "updatedAt", "useSSL") SELECT "backendName", "bindAddress", "bindPort", "containerId", "containerName", "containerPort", "createdAt", "deploymentConfigId", "environmentId", "errorMessage", "frontendName", "frontendType", "hostname", "id", "sslBindPort", "status", "tlsCertificateId", "updatedAt", "useSSL" FROM "haproxy_frontends";
DROP TABLE "haproxy_frontends";
ALTER TABLE "new_haproxy_frontends" RENAME TO "haproxy_frontends";
CREATE UNIQUE INDEX "haproxy_frontends_deploymentConfigId_key" ON "haproxy_frontends"("deploymentConfigId");
CREATE UNIQUE INDEX "haproxy_frontends_frontendName_key" ON "haproxy_frontends"("frontendName");
CREATE INDEX "haproxy_frontends_deploymentConfigId_idx" ON "haproxy_frontends"("deploymentConfigId");
CREATE INDEX "haproxy_frontends_frontendName_idx" ON "haproxy_frontends"("frontendName");
CREATE INDEX "haproxy_frontends_hostname_idx" ON "haproxy_frontends"("hostname");
CREATE INDEX "haproxy_frontends_status_idx" ON "haproxy_frontends"("status");
CREATE INDEX "haproxy_frontends_tlsCertificateId_idx" ON "haproxy_frontends"("tlsCertificateId");
CREATE INDEX "haproxy_frontends_frontendType_idx" ON "haproxy_frontends"("frontendType");
CREATE INDEX "haproxy_frontends_environmentId_idx" ON "haproxy_frontends"("environmentId");
CREATE INDEX "haproxy_frontends_isSharedFrontend_idx" ON "haproxy_frontends"("isSharedFrontend");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "haproxy_routes_sharedFrontendId_idx" ON "haproxy_routes"("sharedFrontendId");

-- CreateIndex
CREATE INDEX "haproxy_routes_hostname_idx" ON "haproxy_routes"("hostname");

-- CreateIndex
CREATE INDEX "haproxy_routes_status_idx" ON "haproxy_routes"("status");

-- CreateIndex
CREATE INDEX "haproxy_routes_sourceType_idx" ON "haproxy_routes"("sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_routes_sharedFrontendId_hostname_key" ON "haproxy_routes"("sharedFrontendId", "hostname");
