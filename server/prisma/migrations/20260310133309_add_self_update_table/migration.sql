-- CreateTable
CREATE TABLE "self_updates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetTag" TEXT NOT NULL,
    "fullImageRef" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "progress" INTEGER,
    "errorMessage" TEXT,
    "sidecarId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "self_updates_state_idx" ON "self_updates"("state");

-- CreateIndex
CREATE INDEX "self_updates_startedAt_idx" ON "self_updates"("startedAt");
