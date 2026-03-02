-- AlterTable
ALTER TABLE "agent_conversations" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "agent_conversations_deletedAt_idx" ON "agent_conversations"("deletedAt");
