-- First-class NATS management

ALTER TABLE "stacks" ADD COLUMN "lastAppliedNatsSnapshot" TEXT;
ALTER TABLE "stack_services" ADD COLUMN "natsCredentialRef" TEXT;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsAccounts" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsCredentials" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsStreams" JSONB;
ALTER TABLE "stack_template_versions" ADD COLUMN "natsConsumers" JSONB;
ALTER TABLE "stack_template_services" ADD COLUMN "natsCredentialRef" TEXT;

CREATE TABLE "nats_state" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "nats_accounts" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "nats_credential_profiles" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nats_credential_profiles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "nats_streams" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nats_streams_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "nats_consumers" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nats_consumers_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "nats_streams" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "stack_nats_resources" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "stackId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "concreteName" TEXT NOT NULL,
  "scope" TEXT,
  CONSTRAINT "stack_nats_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "nats_state_kind_key" ON "nats_state"("kind");
CREATE UNIQUE INDEX "nats_accounts_name_key" ON "nats_accounts"("name");
CREATE INDEX "nats_accounts_isSystem_idx" ON "nats_accounts"("isSystem");
CREATE UNIQUE INDEX "nats_credential_profiles_name_key" ON "nats_credential_profiles"("name");
CREATE INDEX "nats_credential_profiles_accountId_idx" ON "nats_credential_profiles"("accountId");
CREATE UNIQUE INDEX "nats_streams_name_key" ON "nats_streams"("name");
CREATE INDEX "nats_streams_accountId_idx" ON "nats_streams"("accountId");
CREATE UNIQUE INDEX "nats_consumers_streamId_name_key" ON "nats_consumers"("streamId", "name");
CREATE INDEX "nats_consumers_streamId_idx" ON "nats_consumers"("streamId");
CREATE UNIQUE INDEX "stack_nats_resources_stackId_type_concreteName_key" ON "stack_nats_resources"("stackId", "type", "concreteName");
CREATE INDEX "stack_nats_resources_type_concreteName_idx" ON "stack_nats_resources"("type", "concreteName");
ALTER TABLE "stack_services" ADD COLUMN "natsCredentialId" TEXT REFERENCES "nats_credential_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stack_template_services" ADD COLUMN "natsCredentialId" TEXT REFERENCES "nats_credential_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "stack_services_natsCredentialId_idx" ON "stack_services"("natsCredentialId");
CREATE INDEX "stack_template_services_natsCredentialId_idx" ON "stack_template_services"("natsCredentialId");
