-- CreateTable
CREATE TABLE "stack_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "category" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "draftVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "stack_templates_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "stack_template_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stack_templates_draftVersionId_fkey" FOREIGN KEY ("draftVersionId") REFERENCES "stack_template_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "parameters" JSONB NOT NULL,
    "defaultParameterValues" JSONB NOT NULL,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "stack_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL,
    "containerConfig" JSONB NOT NULL,
    "initCommands" JSONB,
    "dependsOn" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "routing" JSONB,
    CONSTRAINT "stack_template_services_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "stack_template_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_config_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "permissions" TEXT,
    "owner" TEXT,
    CONSTRAINT "stack_template_config_files_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "stack_template_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stacks" ("builtinVersion", "createdAt", "description", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "parameterValues", "parameters", "status", "updatedAt", "version", "volumes") SELECT "builtinVersion", "createdAt", "description", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "parameterValues", "parameters", "status", "updatedAt", "version", "volumes" FROM "stacks";
DROP TABLE "stacks";
ALTER TABLE "new_stacks" RENAME TO "stacks";
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");
CREATE INDEX "stacks_status_idx" ON "stacks"("status");
CREATE INDEX "stacks_templateId_idx" ON "stacks"("templateId");
CREATE UNIQUE INDEX "stacks_name_environmentId_key" ON "stacks"("name", "environmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_currentVersionId_key" ON "stack_templates"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_draftVersionId_key" ON "stack_templates"("draftVersionId");

-- CreateIndex
CREATE INDEX "stack_templates_source_idx" ON "stack_templates"("source");

-- CreateIndex
CREATE INDEX "stack_templates_scope_idx" ON "stack_templates"("scope");

-- CreateIndex
CREATE INDEX "stack_templates_isArchived_idx" ON "stack_templates"("isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_name_source_key" ON "stack_templates"("name", "source");

-- CreateIndex
CREATE INDEX "stack_template_versions_templateId_idx" ON "stack_template_versions"("templateId");

-- CreateIndex
CREATE INDEX "stack_template_versions_status_idx" ON "stack_template_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_versions_templateId_version_key" ON "stack_template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "stack_template_services_versionId_idx" ON "stack_template_services"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_services_versionId_serviceName_key" ON "stack_template_services"("versionId", "serviceName");

-- CreateIndex
CREATE INDEX "stack_template_config_files_versionId_idx" ON "stack_template_config_files"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_config_files_versionId_serviceName_volumeName_mountPath_key" ON "stack_template_config_files"("versionId", "serviceName", "volumeName", "mountPath");
