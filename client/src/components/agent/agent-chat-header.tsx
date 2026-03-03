import { IconRobot, IconPlus, IconX, IconHistory } from "@tabler/icons-react";
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
  const { model, sessionStatus, startNewChat, setIsOpen, isHistoryOpen, setIsHistoryOpen } =
    useAgentChat();

  const isProcessing =
    sessionStatus === "streaming" ||
    sessionStatus === "waiting" ||
    sessionStatus === "connecting";

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
          className="size-2 rounded-full bg-green-500"
          title="Available"
        />
        <span
          className={cn(
            "size-2 rounded-full",
            isProcessing ? "bg-green-500 animate-pulse" : "bg-gray-400",
          )}
          title={isProcessing ? "Processing" : "Idle"}
        />
      </div>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7", isHistoryOpen && "bg-muted")}
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
            >
              <IconHistory className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Chat history</TooltipContent>
        </Tooltip>
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
