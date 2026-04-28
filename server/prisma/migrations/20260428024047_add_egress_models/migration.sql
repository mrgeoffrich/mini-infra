-- AlterTable
ALTER TABLE "environments" ADD COLUMN "egressGatewayIp" TEXT;

-- CreateTable
CREATE TABLE "egress_policies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT,
    "stackNameSnapshot" TEXT NOT NULL,
    "environmentId" TEXT,
    "environmentNameSnapshot" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'detect',
    "defaultAction" TEXT NOT NULL DEFAULT 'allow',
    "version" INTEGER NOT NULL DEFAULT 1,
    "appliedVersion" INTEGER,
    "archivedAt" DATETIME,
    "archivedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "egress_policies_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "egress_policies_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "egress_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "targets" JSONB NOT NULL DEFAULT [],
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "egress_rules_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "egress_policies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "egress_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceContainerId" TEXT,
    "sourceStackId" TEXT,
    "sourceServiceName" TEXT,
    "destination" TEXT NOT NULL,
    "matchedPattern" TEXT,
    "action" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'dns',
    "mergedHits" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "egress_events_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "egress_policies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "egress_policies_stackId_idx" ON "egress_policies"("stackId");

-- CreateIndex
CREATE INDEX "egress_policies_environmentId_idx" ON "egress_policies"("environmentId");

-- CreateIndex
CREATE INDEX "egress_policies_archivedAt_idx" ON "egress_policies"("archivedAt");

-- CreateIndex
CREATE INDEX "egress_rules_policyId_idx" ON "egress_rules"("policyId");

-- CreateIndex
CREATE INDEX "egress_rules_policyId_pattern_idx" ON "egress_rules"("policyId", "pattern");

-- CreateIndex
CREATE INDEX "egress_events_policyId_occurredAt_idx" ON "egress_events"("policyId", "occurredAt");

-- CreateIndex
CREATE INDEX "egress_events_policyId_action_idx" ON "egress_events"("policyId", "action");
