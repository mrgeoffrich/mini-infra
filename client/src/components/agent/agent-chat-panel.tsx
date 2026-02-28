import { useEffect, useRef } from "react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useSidebar } from "@/components/ui/sidebar";
import { AgentChatHeader } from "./agent-chat-header";
import { AgentChatMessages } from "./agent-chat-messages";
import { AgentChatInput } from "./agent-chat-input";
import { cn } from "@/lib/utils";

export function AgentChatPanel() {
  const { isOpen, agentEnabled } = useAgentChat();
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

  return (
    <aside
      className={cn(
        "sticky top-0 h-svh shrink-0 border-l bg-background transition-[width] duration-300 ease-in-out",
        isOpen ? "w-[420px]" : "w-0 overflow-hidden",
      )}
    >
      {isOpen && (
        <div className="flex h-full w-[420px] flex-col">
          <AgentChatHeader />
          <AgentChatMessages />
          <AgentChatInput />
        </div>
      )}
    </aside>
  );
}
