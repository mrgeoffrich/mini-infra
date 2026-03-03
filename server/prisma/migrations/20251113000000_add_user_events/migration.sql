-- CreateTable
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "eventCategory" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "userId" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "resourceName" TEXT,
    "description" TEXT,
    "metadata" TEXT,
    "resultSummary" TEXT,
    "errorMessage" TEXT,
    "errorDetails" TEXT,
    "logs" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "user_events_eventType_idx" ON "user_events"("eventType");

-- CreateIndex
CREATE INDEX "user_events_eventCategory_idx" ON "user_events"("eventCategory");

-- CreateIndex
CREATE INDEX "user_events_userId_idx" ON "user_events"("userId");

-- CreateIndex
CREATE INDEX "user_events_status_idx" ON "user_events"("status");

-- CreateIndex
CREATE INDEX "user_events_startedAt_idx" ON "user_events"("startedAt");

-- CreateIndex
CREATE INDEX "user_events_resourceType_resourceId_idx" ON "user_events"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "user_events_expiresAt_idx" ON "user_events"("expiresAt");
