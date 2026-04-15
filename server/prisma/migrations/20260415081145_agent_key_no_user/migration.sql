-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "permissions" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_api_keys" ("active", "createdAt", "id", "key", "lastUsedAt", "name", "permissions", "updatedAt", "userId") SELECT "active", "createdAt", "id", "key", "lastUsedAt", "name", "permissions", "updatedAt", "userId" FROM "api_keys";
DROP TABLE "api_keys";
ALTER TABLE "new_api_keys" RENAME TO "api_keys";
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
