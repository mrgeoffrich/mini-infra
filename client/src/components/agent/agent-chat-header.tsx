import { IconRobot, IconPlus, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { cn } from "@/lib/utils";

export function AgentChatHeader() {
  const { model, sessionStatus, startNewChat, setIsOpen } = useAgentChat();

  const statusColor =
    sessionStatus === "streaming"
      ? "bg-green-500"
      : sessionStatus === "waiting" || sessionStatus === "connecting"
        ? "bg-amber-500"
        : "bg-gray-400";

  return (
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <IconRobot className="size-5 text-muted-foreground" />
        <span className="font-semibold text-sm">Assistant</span>
        {model && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {model}
          </Badge>
        )}
        <span
          className={cn("size-2 rounded-full", statusColor)}
          title={sessionStatus}
        />
      </div>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={startNewChat}>
              <IconPlus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setIsOpen(false)}
            >
              <IconX className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
