-- CreateTable
CREATE TABLE "agent_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "agent_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_conversation_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolId" TEXT,
    "toolName" TEXT,
    "toolInput" TEXT,
    "toolOutput" TEXT,
    "success" BOOLEAN,
    "cost" REAL,
    "duration" REAL,
    "turns" INTEGER,
    "sequence" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "agent_conversations_userId_idx" ON "agent_conversations"("userId");

-- CreateIndex
CREATE INDEX "agent_conversations_userId_updatedAt_idx" ON "agent_conversations"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_conversation_messages_conversationId_idx" ON "agent_conversation_messages"("conversationId");

-- CreateIndex
CREATE INDEX "agent_conversation_messages_conversationId_sequence_idx" ON "agent_conversation_messages"("conversationId", "sequence");
