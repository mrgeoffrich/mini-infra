import { useEffect, useRef, useCallback } from "react";
import { IconAlertTriangle, IconChevronRight } from "@tabler/icons-react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { DocContent } from "@/components/help/DocContent";
import { AgentChatWelcome } from "./agent-chat-welcome";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ChatMessage,
  ChatMessageToolUse,
} from "@/lib/agent-chat-types";

function parseToolDisplay(msg: ChatMessageToolUse) {
  const input = msg.input as Record<string, unknown> | undefined;

  // For Bash tool with a command
  if (msg.toolName === "Bash" && input?.command) {
    return {
      method: "EXEC",
      endpoint: String(input.command).slice(0, 80),
      detail: String(input.command),
      color: "bg-purple-600",
    };
  }

  // For curl-based tools, try to parse method + URL from the command
  if (input?.command && typeof input.command === "string") {
    const curlMatch = input.command.match(
      /curl\s+(?:-X\s+(\w+)\s+)?.*?(https?:\/\/\S+)/,
    );
    if (curlMatch) {
      const method = curlMatch[1] || "GET";
      const url = curlMatch[2];
      return {
        method: method.toUpperCase(),
        endpoint: url.replace(/^https?:\/\/[^/]+/, ""),
        detail: input.command as string,
        color: methodColor(method.toUpperCase()),
      };
    }
  }

  // For Read/Glob tools
  if (msg.toolName === "Read" || msg.toolName === "Glob") {
    const path = input?.file_path || input?.pattern || "";
    return {
      method: msg.toolName.toUpperCase(),
      endpoint: String(path).slice(0, 80),
      detail: JSON.stringify(input, null, 2),
      color: "bg-cyan-600",
    };
  }

  // Generic fallback
  return {
    method: msg.toolName,
    endpoint: "",
    detail: input ? JSON.stringify(input, null, 2) : "",
    color: "bg-gray-500",
  };
}

function methodColor(method: string): string {
  switch (method) {
    case "GET":
      return "bg-green-600";
    case "POST":
      return "bg-blue-600";
    case "PUT":
    case "PATCH":
      return "bg-amber-600";
    case "DELETE":
      return "bg-red-600";
    default:
      return "bg-gray-500";
  }
}

function ToolUseBlock({ msg }: { msg: ChatMessageToolUse }) {
  const { method, endpoint, detail, color } = parseToolDisplay(msg);

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs hover:bg-muted transition-colors text-left">
        <IconChevronRight className="size-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90" />
        <Badge
          className={cn(
            "text-[10px] px-1.5 py-0 text-white border-0 shrink-0",
            color,
          )}
        >
          {method}
        </Badge>
        <span className="truncate font-mono text-muted-foreground">
          {endpoint}
        </span>
        {msg.output === undefined && (
          <span className="ml-auto shrink-0 size-2 rounded-full bg-amber-500 animate-pulse" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1">
        {detail && (
          <pre className="overflow-x-auto rounded-md border bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all">
            {detail}
          </pre>
        )}
        {msg.output !== undefined && (
          <pre className="overflow-x-auto rounded-md border bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-48">
            {msg.output}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  switch (msg.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap">
            {msg.content}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] text-sm">
            <DocContent
              content={msg.content}
              className="[&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:text-xs [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm"
            />
          </div>
        </div>
      );

    case "tool_use":
      return <ToolUseBlock msg={msg} />;

    case "error":
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <IconAlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{msg.content}</span>
        </div>
      );

    case "result":
      return (
        <div className="text-xs text-muted-foreground text-center py-2">
          {msg.success ? "Completed" : "Failed"}
          {msg.turns != null && ` · ${msg.turns} turn${msg.turns !== 1 ? "s" : ""}`}
          {msg.duration != null &&
            ` · ${(msg.duration / 1000).toFixed(1)}s`}
          {msg.cost != null && ` · $${msg.cost.toFixed(4)}`}
        </div>
      );
  }
}

export function AgentChatMessages() {
  const { messages, streamingText } = useAgentChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 80;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  return (
    <div
      ref={scrollRef}
      onScroll={checkNearBottom}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
    >
      {messages.length === 0 && !streamingText && <AgentChatWelcome />}

      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}

      {streamingText && (
        <div className="flex justify-start">
          <div className="max-w-[85%] text-sm">
            <DocContent
              content={streamingText}
              className="[&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:text-xs [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm"
            />
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-foreground/70 animate-pulse align-text-bottom" />
          </div>
        </div>
      )}
    </div>
  );
}
