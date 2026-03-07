-- CreateTable
CREATE TABLE "stacks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'undeployed',
    "lastAppliedVersion" INTEGER,
    "lastAppliedAt" DATETIME,
    "lastAppliedSnapshot" JSONB,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL,
    "containerConfig" JSONB NOT NULL,
    "configFiles" JSONB,
    "initCommands" JSONB,
    "dependsOn" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "routing" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_services_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");

-- CreateIndex
CREATE INDEX "stacks_status_idx" ON "stacks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stacks_name_environmentId_key" ON "stacks"("name", "environmentId");

-- CreateIndex
CREATE INDEX "stack_services_stackId_idx" ON "stack_services"("stackId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_services_stackId_serviceName_key" ON "stack_services"("stackId", "serviceName");
