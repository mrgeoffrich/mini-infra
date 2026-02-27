import * as SheetPrimitive from "@radix-ui/react-dialog";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { AgentChatHeader } from "./agent-chat-header";
import { AgentChatMessages } from "./agent-chat-messages";
import { AgentChatInput } from "./agent-chat-input";
import { cn } from "@/lib/utils";

export function AgentChatSheet() {
  const { isOpen, setIsOpen, agentEnabled } = useAgentChat();

  if (!agentEnabled) return null;

  return (
    <SheetPrimitive.Root open={isOpen} onOpenChange={setIsOpen} modal={false}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            "bg-background fixed z-50 flex flex-col shadow-lg transition ease-in-out",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:duration-300 data-[state=open]:duration-500",
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
            "inset-y-0 right-0 h-full w-[420px] max-w-[90vw] border-l",
          )}
        >
          <SheetPrimitive.Title className="sr-only">
            AI Assistant
          </SheetPrimitive.Title>
          <SheetPrimitive.Description className="sr-only">
            Chat with the AI assistant about your infrastructure
          </SheetPrimitive.Description>
          <AgentChatHeader />
          <AgentChatMessages />
          <AgentChatInput />
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
