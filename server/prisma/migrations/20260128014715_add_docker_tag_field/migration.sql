-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_deployment_configurations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationName" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL DEFAULT 'latest',
    "dockerRegistry" TEXT,
    "containerConfig" JSONB NOT NULL,
    "healthCheckConfig" JSONB NOT NULL,
    "rollbackConfig" JSONB NOT NULL,
    "listeningPort" INTEGER,
    "hostname" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "environmentId" TEXT NOT NULL,
    "enableSsl" BOOLEAN NOT NULL DEFAULT false,
    "tlsCertificateId" TEXT,
    "certificateStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "deployment_configurations_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "deployment_configurations_tlsCertificateId_fkey" FOREIGN KEY ("tlsCertificateId") REFERENCES "tls_certificates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_deployment_configurations" ("applicationName", "certificateStatus", "containerConfig", "createdAt", "dockerImage", "dockerRegistry", "enableSsl", "environmentId", "healthCheckConfig", "hostname", "id", "isActive", "listeningPort", "rollbackConfig", "tlsCertificateId", "updatedAt") SELECT "applicationName", "certificateStatus", "containerConfig", "createdAt", "dockerImage", "dockerRegistry", "enableSsl", "environmentId", "healthCheckConfig", "hostname", "id", "isActive", "listeningPort", "rollbackConfig", "tlsCertificateId", "updatedAt" FROM "deployment_configurations";
DROP TABLE "deployment_configurations";
ALTER TABLE "new_deployment_configurations" RENAME TO "deployment_configurations";
CREATE UNIQUE INDEX "deployment_configurations_applicationName_key" ON "deployment_configurations"("applicationName");
CREATE INDEX "deployment_configurations_environmentId_idx" ON "deployment_configurations"("environmentId");
CREATE INDEX "deployment_configurations_hostname_idx" ON "deployment_configurations"("hostname");
CREATE INDEX "deployment_configurations_tlsCertificateId_idx" ON "deployment_configurations"("tlsCertificateId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
