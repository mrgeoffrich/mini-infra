import { useEffect, useRef } from "react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useSidebar } from "@/components/ui/sidebar";
import { AgentChatHeader } from "./agent-chat-header";
import { AgentChatMessages } from "./agent-chat-messages";
import { AgentChatInput } from "./agent-chat-input";
import { AgentChatHistory } from "./agent-chat-history";
import { cn } from "@/lib/utils";

export function AgentChatPanel() {
  const { isOpen, agentEnabled, isHistoryOpen } = useAgentChat();
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  const previousSidebarState = useRef<boolean | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (isOpen) {
      // Save current sidebar state before collapsing
      previousSidebarState.current = sidebarOpen;
      setSidebarOpen(false);
    } else {
      // Restore saved sidebar state
      if (previousSidebarState.current !== null) {
        setSidebarOpen(previousSidebarState.current);
        previousSidebarState.current = null;
      }
    }
    // Only react to isOpen changes — not sidebarOpen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!agentEnabled) return null;

  // Total panel width: history (280px when open) + chat (420px)
  const totalWidth = isOpen
    ? isHistoryOpen
      ? "w-[700px]"
      : "w-[420px]"
    : "w-0";

  return (
    <div
      className={cn(
        "sticky top-0 flex h-svh shrink-0 transition-[width] duration-300 ease-in-out",
        isOpen ? totalWidth : "w-0 overflow-hidden",
      )}
    >
      {isOpen && (
        <>
          <AgentChatHistory />
          <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background">
            <AgentChatHeader />
            <AgentChatMessages />
            <AgentChatInput />
          </aside>
        </>
      )}
    </div>
  );
}
