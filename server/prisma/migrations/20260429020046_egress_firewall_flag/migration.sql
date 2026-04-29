-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "networkType" TEXT NOT NULL DEFAULT 'local',
    "tunnelId" TEXT,
    "tunnelServiceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "egressGatewayIp" TEXT,
    "egressFirewallEnabled" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_environments" ("createdAt", "description", "egressGatewayIp", "id", "name", "networkType", "tunnelId", "tunnelServiceUrl", "type", "updatedAt") SELECT "createdAt", "description", "egressGatewayIp", "id", "name", "networkType", "tunnelId", "tunnelServiceUrl", "type", "updatedAt" FROM "environments";
DROP TABLE "environments";
ALTER TABLE "new_environments" RENAME TO "environments";
CREATE UNIQUE INDEX "environments_name_key" ON "environments"("name");
CREATE INDEX "environments_type_idx" ON "environments"("type");
CREATE INDEX "environments_networkType_idx" ON "environments"("networkType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
