-- AlterTable
ALTER TABLE "stack_templates" ADD COLUMN "environmentId" TEXT;

-- CreateIndex
CREATE INDEX "stack_templates_environmentId_idx" ON "stack_templates"("environmentId");
