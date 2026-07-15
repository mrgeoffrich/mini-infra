import { Suspense, lazy, useEffect, useRef } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useSidebar } from "@/components/ui/sidebar";
import { AgentChatHeader } from "./agent-chat-header";
import { AgentChatInput } from "./agent-chat-input";
import { AgentChatHistory } from "./agent-chat-history";
import { cn } from "@/lib/utils";

// The message list is the only thing in the app that pulls in react-markdown
// (+ remark/rehype) — a heavy stack that has no business in the initial bundle
// for a panel most sessions never open. Lazy-load it so that chunk is fetched
// only when the agent panel is actually opened. See the code-splitting work in
// the P6 roadmap item (5.4).
const AgentChatMessages = lazy(() =>
  import("./agent-chat-messages").then((m) => ({ default: m.AgentChatMessages })),
);

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
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center">
                  <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <AgentChatMessages />
            </Suspense>
            <AgentChatInput />
          </aside>
        </>
      )}
    </div>
  );
}
