-- CreateTable
CREATE TABLE "stack_vault_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "concreteName" TEXT NOT NULL,
    "scope" TEXT,
    CONSTRAINT "stack_vault_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "stack_vault_resources_type_concreteName_idx" ON "stack_vault_resources"("type", "concreteName");

-- CreateIndex
CREATE UNIQUE INDEX "stack_vault_resources_stackId_type_concreteName_key" ON "stack_vault_resources"("stackId", "type", "concreteName");
