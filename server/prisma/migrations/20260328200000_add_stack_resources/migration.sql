-- CreateTable
CREATE TABLE "stack_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "fqdn" TEXT NOT NULL,
    "externalId" TEXT,
    "externalState" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable: Add resource columns to stacks
ALTER TABLE "stacks" ADD COLUMN "tlsCertificates" TEXT;
ALTER TABLE "stacks" ADD COLUMN "dnsRecords" TEXT;
ALTER TABLE "stacks" ADD COLUMN "tunnelIngress" TEXT;

-- AlterTable: Add resourceResults to stack_deployments
ALTER TABLE "stack_deployments" ADD COLUMN "resourceResults" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "stack_resources_stackId_resourceType_resourceName_key" ON "stack_resources"("stackId", "resourceType", "resourceName");

-- CreateIndex
CREATE INDEX "stack_resources_stackId_idx" ON "stack_resources"("stackId");
