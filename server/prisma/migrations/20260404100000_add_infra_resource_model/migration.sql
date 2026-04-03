-- CreateTable: infra_resources
CREATE TABLE "infra_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "environmentId" TEXT,
    "stackId" TEXT,
    "name" TEXT NOT NULL,
    "dockerId" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "infra_resources_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "infra_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "infra_resources_stackId_idx" ON "infra_resources"("stackId");

-- CreateIndex
CREATE INDEX "infra_resources_environmentId_idx" ON "infra_resources"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "infra_resources_type_purpose_scope_environmentId_key" ON "infra_resources"("type", "purpose", "scope", "environmentId");

-- Add resourceOutputs and resourceInputs columns to stacks
ALTER TABLE "stacks" ADD COLUMN "resourceOutputs" TEXT;
ALTER TABLE "stacks" ADD COLUMN "resourceInputs" TEXT;

-- Add resourceOutputs and resourceInputs columns to stack_template_versions
ALTER TABLE "stack_template_versions" ADD COLUMN "resourceOutputs" TEXT;
ALTER TABLE "stack_template_versions" ADD COLUMN "resourceInputs" TEXT;
