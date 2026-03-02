import { IconTrash, IconMessageCircle } from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchConversationDetail } from "@/hooks/use-agent-conversations";
import { persistedMessagesToChatMessages } from "@/hooks/use-agent-session";
import type { AgentConversationSummary } from "@mini-infra/types";

interface ConversationItemProps {
  conversation: AgentConversationSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
}: ConversationItemProps) {
  const relativeTime = formatDistanceToNow(new Date(conversation.updatedAt), {
    addSuffix: true,
  });

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-muted",
        isActive && "bg-muted",
      )}
      onClick={() => onSelect(conversation.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(conversation.id);
      }}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="line-clamp-2 flex-1 text-sm font-medium leading-snug">
          {conversation.title}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(conversation.id);
          }}
          title="Delete conversation"
        >
          <IconTrash className="size-3" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{relativeTime}</p>
    </div>
  );
}

export function AgentChatHistory() {
  const {
    isHistoryOpen,
    conversations,
    activeConversationId,
    loadConversation,
    deleteConversation,
  } = useAgentChat();

  async function handleSelect(conversationId: string) {
    try {
      const detail = await fetchConversationDetail(conversationId);
      const msgs = persistedMessagesToChatMessages(detail.messages);
      loadConversation(conversationId, msgs);
    } catch {
      toast.error("Failed to load conversation");
    }
  }

  async function handleDelete(conversationId: string) {
    try {
      await deleteConversation(conversationId);
    } catch {
      toast.error("Failed to delete conversation");
    }
  }

  return (
    <aside
      className={cn(
        "flex h-svh shrink-0 flex-col border-r bg-background transition-[width] duration-300 ease-in-out",
        isHistoryOpen ? "w-[280px]" : "w-0 overflow-hidden",
      )}
    >
      {isHistoryOpen && (
        <div className="flex h-full w-[280px] flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <IconMessageCircle className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Chat History</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
                <IconMessageCircle className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">No past conversations yet.</p>
                <p className="text-xs text-muted-foreground">
                  Start a chat and it will appear here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 p-2">
                {conversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === activeConversationId}
                    onSelect={(id) => void handleSelect(id)}
                    onDelete={(id) => void handleDelete(id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
