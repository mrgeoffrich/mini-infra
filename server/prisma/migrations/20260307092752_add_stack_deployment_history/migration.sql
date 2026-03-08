-- CreateTable
CREATE TABLE "stack_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "version" INTEGER,
    "status" TEXT NOT NULL,
    "duration" INTEGER,
    "serviceResults" JSONB,
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stack_deployments_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "stack_deployments_stackId_idx" ON "stack_deployments"("stackId");

-- CreateIndex
CREATE INDEX "stack_deployments_createdAt_idx" ON "stack_deployments"("createdAt");
