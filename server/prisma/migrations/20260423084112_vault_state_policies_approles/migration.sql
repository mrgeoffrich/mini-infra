-- CreateTable
CREATE TABLE "vault_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "stackId" TEXT,
    "address" TEXT,
    "initialised" BOOLEAN NOT NULL DEFAULT false,
    "initialisedAt" DATETIME,
    "bootstrappedAt" DATETIME,
    "passphraseSalt" BLOB,
    "passphraseProbe" BLOB,
    "encryptedUnsealKeys" BLOB,
    "encryptedRootToken" BLOB,
    "encryptedAdminRoleId" BLOB,
    "encryptedAdminSecretId" BLOB,
    "encryptedAdminSecretIdAt" DATETIME,
    "encryptedOperatorPassword" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vault_policies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "draftHclBody" TEXT,
    "publishedHclBody" TEXT,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "lastAppliedAt" DATETIME,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vault_app_roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "secretIdNumUses" INTEGER NOT NULL DEFAULT 1,
    "secretIdTtl" TEXT NOT NULL DEFAULT '0',
    "tokenTtl" TEXT,
    "tokenMaxTtl" TEXT,
    "tokenPeriod" TEXT,
    "cachedRoleId" TEXT,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "vault_app_roles_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "vault_policies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_stacks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'undeployed',
    "lastAppliedVersion" INTEGER,
    "lastAppliedAt" DATETIME,
    "lastAppliedSnapshot" JSONB,
    "builtinVersion" INTEGER,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "parameters" JSONB,
    "parameterValues" JSONB,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "tlsCertificates" JSONB,
    "dnsRecords" JSONB,
    "tunnelIngress" JSONB,
    "resourceOutputs" JSONB,
    "resourceInputs" JSONB,
    "removedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "vaultAppRoleId" TEXT,
    "vaultFailClosed" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_vaultAppRoleId_fkey" FOREIGN KEY ("vaultAppRoleId") REFERENCES "vault_app_roles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stacks" ("builtinVersion", "createdAt", "description", "dnsRecords", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "parameterValues", "parameters", "removedAt", "resourceInputs", "resourceOutputs", "status", "templateId", "templateVersion", "tlsCertificates", "tunnelIngress", "updatedAt", "version", "volumes") SELECT "builtinVersion", "createdAt", "description", "dnsRecords", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "parameterValues", "parameters", "removedAt", "resourceInputs", "resourceOutputs", "status", "templateId", "templateVersion", "tlsCertificates", "tunnelIngress", "updatedAt", "version", "volumes" FROM "stacks";
DROP TABLE "stacks";
ALTER TABLE "new_stacks" RENAME TO "stacks";
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");
CREATE INDEX "stacks_status_idx" ON "stacks"("status");
CREATE INDEX "stacks_templateId_idx" ON "stacks"("templateId");
CREATE INDEX "stacks_vaultAppRoleId_idx" ON "stacks"("vaultAppRoleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "vault_state_kind_key" ON "vault_state"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "vault_policies_name_key" ON "vault_policies"("name");

-- CreateIndex
CREATE INDEX "vault_policies_isSystem_idx" ON "vault_policies"("isSystem");

-- CreateIndex
CREATE UNIQUE INDEX "vault_app_roles_name_key" ON "vault_app_roles"("name");

-- CreateIndex
CREATE INDEX "vault_app_roles_policyId_idx" ON "vault_app_roles"("policyId");
