-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_environment_networks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'custom',
    "driver" TEXT NOT NULL DEFAULT 'bridge',
    "options" JSONB,
    "dockerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_networks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_environment_networks" ("createdAt", "dockerId", "driver", "environmentId", "id", "name", "options", "purpose") SELECT "createdAt", "dockerId", "driver", "environmentId", "id", "name", "options", CASE WHEN "name" LIKE '%haproxy%' THEN 'applications' ELSE 'custom' END FROM "environment_networks";
DROP TABLE "environment_networks";
ALTER TABLE "new_environment_networks" RENAME TO "environment_networks";
CREATE INDEX "environment_networks_environmentId_idx" ON "environment_networks"("environmentId");
CREATE UNIQUE INDEX "environment_networks_environmentId_name_key" ON "environment_networks"("environmentId", "name");
CREATE UNIQUE INDEX "environment_networks_environmentId_purpose_key" ON "environment_networks"("environmentId", "purpose");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
