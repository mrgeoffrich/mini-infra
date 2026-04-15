import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import type {
  AgentConversationSummary,
  AgentConversationDetail,
  AgentPersistedMessage,
  AgentMessageRole,
} from "@mini-infra/types";

const logger = getLogger("agent", "agent-conversation-service");

export interface CreateMessageData {
  conversationId: string;
  role: AgentMessageRole;
  content?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  success?: boolean;
  cost?: number;
  duration?: number;
  turns?: number;
  sequence: number;
}

export class AgentConversationService {
  async createConversation(userId: string, firstMessage: string): Promise<string> {
    const title = firstMessage.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
    const conv = await prisma.agentConversation.create({
      data: { userId, title },
    });
    logger.debug({ conversationId: conv.id, userId }, "Agent conversation created");
    return conv.id;
  }

  async addMessage(data: CreateMessageData): Promise<void> {
    await prisma.agentConversationMessage.create({
      data: {
        conversationId: data.conversationId,
        role: data.role,
        content: data.content ?? null,
        toolId: data.toolId ?? null,
        toolName: data.toolName ?? null,
        toolInput: data.toolInput ? JSON.stringify(data.toolInput) : null,
        toolOutput: data.toolOutput ?? null,
        success: data.success ?? null,
        cost: data.cost ?? null,
        duration: data.duration ?? null,
        turns: data.turns ?? null,
        sequence: data.sequence,
      },
    });
  }

  async updateSdkSessionId(conversationId: string, sdkSessionId: string): Promise<void> {
    await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { sdkSessionId },
    });
    logger.debug({ conversationId, sdkSessionId }, "Updated SDK session ID");
  }

  async getSdkSessionId(conversationId: string): Promise<string | null> {
    const conv = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: { sdkSessionId: true },
    });
    return conv?.sdkSessionId ?? null;
  }

  async touchConversation(conversationId: string): Promise<void> {
    await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  async listConversations(userId: string, limit = 50): Promise<AgentConversationSummary[]> {
    const convs = await prisma.agentConversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return convs.map((c) => ({
      id: c.id,
      userId: c.userId,
      title: c.title,
      sdkSessionId: c.sdkSessionId ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async getConversationDetail(
    conversationId: string,
    userId: string,
  ): Promise<AgentConversationDetail | null> {
    const conv = await prisma.agentConversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
      include: { messages: { orderBy: { sequence: "asc" } } },
    });
    if (!conv) return null;

    const messages: AgentPersistedMessage[] = conv.messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role as AgentMessageRole,
      content: m.content,
      toolId: m.toolId,
      toolName: m.toolName,
      toolInput: m.toolInput
        ? (() => {
            try {
              return JSON.parse(m.toolInput!) as Record<string, unknown>;
            } catch {
              logger.warn(
                { conversationId: m.conversationId, messageId: m.id },
                "Failed to parse toolInput JSON — returning null",
              );
              return null;
            }
          })()
        : null,
      toolOutput: m.toolOutput,
      success: m.success,
      cost: m.cost,
      duration: m.duration,
      turns: m.turns,
      sequence: m.sequence,
      createdAt: m.createdAt.toISOString(),
    }));

    return {
      id: conv.id,
      userId: conv.userId,
      title: conv.title,
      sdkSessionId: conv.sdkSessionId ?? null,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      messages,
    };
  }

  async deleteConversation(conversationId: string, userId: string): Promise<boolean> {
    const conv = await prisma.agentConversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
    });
    if (!conv) return false;
    await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { deletedAt: new Date() },
    });
    logger.debug({ conversationId, userId }, "Agent conversation soft-deleted");
    return true;
  }
}

export const agentConversationService = new AgentConversationService();
