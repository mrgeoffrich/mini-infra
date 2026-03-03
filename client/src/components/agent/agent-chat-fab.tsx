import { IconRobot } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentChat } from "@/hooks/use-agent-chat";

export function AgentChatFAB() {
  const { isOpen, setIsOpen, agentEnabled } = useAgentChat();

  if (!agentEnabled || isOpen) return null;

  return (
    <div className="fixed bottom-6 right-6 z-40" data-tour="agent-chat-fab">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="lg"
            className="size-14 rounded-full shadow-lg"
            onClick={() => setIsOpen(true)}
          >
            <IconRobot className="size-6" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Open assistant</TooltipContent>
      </Tooltip>
    </div>
  );
}
