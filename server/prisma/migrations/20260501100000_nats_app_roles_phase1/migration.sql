-- AlterTable
ALTER TABLE "stack_template_services" ADD COLUMN "natsRole" TEXT;
ALTER TABLE "stack_template_services" ADD COLUMN "natsSigner" TEXT;

-- AlterTable
ALTER TABLE "stack_template_versions" ADD COLUMN "natsExports" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsImports" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsRoles" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsSigners" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsSubjectPrefix" TEXT;

-- CreateTable
CREATE TABLE "nats_signing_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "stackId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopedSubject" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "seedKvPath" TEXT NOT NULL,
    "maxTtlSeconds" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_signing_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "nats_signing_keys_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_nats_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "seedKvPath" TEXT NOT NULL,
    "publicKey" TEXT,
    "jwt" TEXT,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_nats_accounts" ("createdAt", "createdById", "description", "displayName", "id", "isSystem", "jwt", "lastAppliedAt", "name", "publicKey", "seedKvPath", "updatedAt", "updatedById") SELECT "createdAt", "createdById", "description", "displayName", "id", "isSystem", "jwt", "lastAppliedAt", "name", "publicKey", "seedKvPath", "updatedAt", "updatedById" FROM "nats_accounts";
DROP TABLE "nats_accounts";
ALTER TABLE "new_nats_accounts" RENAME TO "nats_accounts";
CREATE UNIQUE INDEX "nats_accounts_name_key" ON "nats_accounts"("name");
CREATE INDEX "nats_accounts_isSystem_idx" ON "nats_accounts"("isSystem");
CREATE TABLE "new_nats_consumers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "streamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durableName" TEXT,
    "description" TEXT,
    "filterSubject" TEXT,
    "deliverPolicy" TEXT NOT NULL DEFAULT 'all',
    "ackPolicy" TEXT NOT NULL DEFAULT 'explicit',
    "maxDeliver" INTEGER,
    "ackWaitSeconds" INTEGER,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_consumers_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "nats_streams" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_nats_consumers" ("ackPolicy", "ackWaitSeconds", "createdAt", "createdById", "deliverPolicy", "description", "durableName", "filterSubject", "id", "lastAppliedAt", "maxDeliver", "name", "streamId", "updatedAt", "updatedById") SELECT "ackPolicy", "ackWaitSeconds", "createdAt", "createdById", "deliverPolicy", "description", "durableName", "filterSubject", "id", "lastAppliedAt", "maxDeliver", "name", "streamId", "updatedAt", "updatedById" FROM "nats_consumers";
DROP TABLE "nats_consumers";
ALTER TABLE "new_nats_consumers" RENAME TO "nats_consumers";
CREATE INDEX "nats_consumers_streamId_idx" ON "nats_consumers"("streamId");
CREATE UNIQUE INDEX "nats_consumers_streamId_name_key" ON "nats_consumers"("streamId", "name");
CREATE TABLE "new_nats_credential_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "accountId" TEXT NOT NULL,
    "publishAllow" JSONB NOT NULL,
    "subscribeAllow" JSONB NOT NULL,
    "ttlSeconds" INTEGER NOT NULL DEFAULT 3600,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_credential_profiles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_nats_credential_profiles" ("accountId", "createdAt", "createdById", "description", "displayName", "id", "lastAppliedAt", "name", "publishAllow", "subscribeAllow", "ttlSeconds", "updatedAt", "updatedById") SELECT "accountId", "createdAt", "createdById", "description", "displayName", "id", "lastAppliedAt", "name", "publishAllow", "subscribeAllow", "ttlSeconds", "updatedAt", "updatedById" FROM "nats_credential_profiles";
DROP TABLE "nats_credential_profiles";
ALTER TABLE "new_nats_credential_profiles" RENAME TO "nats_credential_profiles";
CREATE UNIQUE INDEX "nats_credential_profiles_name_key" ON "nats_credential_profiles"("name");
CREATE INDEX "nats_credential_profiles_accountId_idx" ON "nats_credential_profiles"("accountId");
CREATE TABLE "new_nats_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "stackId" TEXT,
    "clientUrl" TEXT,
    "monitorUrl" TEXT,
    "bootstrappedAt" DATETIME,
    "lastAppliedAt" DATETIME,
    "operatorPublic" TEXT,
    "systemAccountPublic" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_nats_state" ("bootstrappedAt", "clientUrl", "createdAt", "id", "kind", "lastAppliedAt", "monitorUrl", "operatorPublic", "stackId", "systemAccountPublic", "updatedAt") SELECT "bootstrappedAt", "clientUrl", "createdAt", "id", "kind", "lastAppliedAt", "monitorUrl", "operatorPublic", "stackId", "systemAccountPublic", "updatedAt" FROM "nats_state";
DROP TABLE "nats_state";
ALTER TABLE "new_nats_state" RENAME TO "nats_state";
CREATE UNIQUE INDEX "nats_state_kind_key" ON "nats_state"("kind");
CREATE TABLE "new_nats_streams" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "subjects" JSONB NOT NULL,
    "retention" TEXT NOT NULL DEFAULT 'limits',
    "storage" TEXT NOT NULL DEFAULT 'file',
    "maxMsgs" INTEGER,
    "maxBytes" INTEGER,
    "maxAgeSeconds" INTEGER,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_streams_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_nats_streams" ("accountId", "createdAt", "createdById", "description", "id", "lastAppliedAt", "maxAgeSeconds", "maxBytes", "maxMsgs", "name", "retention", "storage", "subjects", "updatedAt", "updatedById") SELECT "accountId", "createdAt", "createdById", "description", "id", "lastAppliedAt", "maxAgeSeconds", "maxBytes", "maxMsgs", "name", "retention", "storage", "subjects", "updatedAt", "updatedById" FROM "nats_streams";
DROP TABLE "nats_streams";
ALTER TABLE "new_nats_streams" RENAME TO "nats_streams";
CREATE UNIQUE INDEX "nats_streams_name_key" ON "nats_streams"("name");
CREATE INDEX "nats_streams_accountId_idx" ON "nats_streams"("accountId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "nats_signing_keys_accountId_idx" ON "nats_signing_keys"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "nats_signing_keys_stackId_name_key" ON "nats_signing_keys"("stackId", "name");
