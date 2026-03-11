-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "errorMessage" TEXT,
    "tokenUsage" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "context" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "agent_tasks_status_idx" ON "agent_tasks"("status");

-- CreateIndex
CREATE INDEX "agent_tasks_triggeredBy_idx" ON "agent_tasks"("triggeredBy");

-- CreateIndex
CREATE INDEX "agent_tasks_createdAt_idx" ON "agent_tasks"("createdAt");
