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
    "lastAppliedVaultAppRoleId" TEXT,
    "encryptedInputValues" TEXT,
    "lastAppliedVaultSnapshot" TEXT,
    "lastFailureReason" TEXT,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_vaultAppRoleId_fkey" FOREIGN KEY ("vaultAppRoleId") REFERENCES "vault_app_roles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stacks" ("builtinVersion", "createdAt", "description", "dnsRecords", "encryptedInputValues", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVaultAppRoleId", "lastAppliedVaultSnapshot", "lastAppliedVersion", "lastFailureReason", "name", "networks", "parameterValues", "parameters", "removedAt", "resourceInputs", "resourceOutputs", "status", "templateId", "templateVersion", "tlsCertificates", "tunnelIngress", "updatedAt", "vaultAppRoleId", "vaultFailClosed", "version", "volumes") SELECT "builtinVersion", "createdAt", "description", "dnsRecords", "encryptedInputValues", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVaultAppRoleId", "lastAppliedVaultSnapshot", "lastAppliedVersion", "lastFailureReason", "name", "networks", "parameterValues", "parameters", "removedAt", "resourceInputs", "resourceOutputs", "status", "templateId", "templateVersion", "tlsCertificates", "tunnelIngress", "updatedAt", "vaultAppRoleId", "vaultFailClosed", "version", "volumes" FROM "stacks";
DROP TABLE "stacks";
ALTER TABLE "new_stacks" RENAME TO "stacks";
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");
CREATE INDEX "stacks_status_idx" ON "stacks"("status");
CREATE INDEX "stacks_templateId_idx" ON "stacks"("templateId");
CREATE INDEX "stacks_vaultAppRoleId_idx" ON "stacks"("vaultAppRoleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
