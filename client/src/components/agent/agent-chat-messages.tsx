import { useEffect, useEffectEvent, useRef, useCallback, useState, useMemo } from "react";
import type { ComponentType } from "react";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconNavigation,
  IconFocusCentered,
  IconEye,
  IconSparkles,
  IconApi,
  IconFolderOpen,
  IconFileText,
  IconSearch,
} from "@tabler/icons-react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { DocContent } from "@/components/help/DocContent";
import { AgentChatWelcome } from "./agent-chat-welcome";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  ChatMessage,
  ChatMessageThinking,
  ChatMessageToolUse,
} from "@/lib/agent-chat-types";

const chatMarkdownClasses = cn(
  "[&_p]:text-[13px] [&_p]:leading-5 [&_p]:mb-1.5 [&_p:last-child]:mb-0",
  "[&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1",
  "[&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h2]:border-0 [&_h2]:pb-0",
  "[&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-0.5",
  "[&_ul]:pl-4 [&_ul]:mb-1.5 [&_ul]:space-y-0.5 [&_ol]:pl-4 [&_ol]:mb-1.5 [&_ol]:space-y-0.5",
  "[&_li]:text-[13px] [&_li]:leading-5",
  "[&_pre]:text-[11px] [&_pre]:p-2 [&_pre]:mb-1.5 [&_pre]:mt-1",
  "[&_code]:text-[12px]",
  "[&_blockquote]:mt-1.5 [&_blockquote]:mb-1.5 [&_blockquote]:text-[13px]",
  "[&_li_strong]:font-medium",
  "[&_table]:text-[12px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
);

interface ToolDisplay {
  method: string;
  endpoint: string;
  detail: string;
  color: string;
  icon?: ComponentType<{ className?: string }>;
}

function parseToolDisplay(msg: ChatMessageToolUse): ToolDisplay {
  const input = msg.input as Record<string, unknown> | undefined;

  // MCP UI tools
  if (msg.toolName === "mcp__mini-infra-ui__navigate_to") {
    const path = (input?.path as string) ?? "";
    return {
      method: "Navigate",
      endpoint: path,
      detail: JSON.stringify(input, null, 2),
      color: "bg-indigo-600",
      icon: IconNavigation,
    };
  }

  if (msg.toolName === "mcp__mini-infra-ui__highlight_element") {
    const elementId = (input?.elementId as string) ?? "";
    return {
      method: "Highlight",
      endpoint: elementId,
      detail: JSON.stringify(input, null, 2),
      color: "bg-amber-600",
      icon: IconFocusCentered,
    };
  }

  if (msg.toolName === "mcp__mini-infra-ui__get_current_page") {
    return {
      method: "Get Page",
      endpoint: "",
      detail: "",
      color: "bg-teal-600",
      icon: IconEye,
    };
  }

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

  // Skill tool
  if (msg.toolName === "Skill") {
    const skillName = (input?.skill as string) ?? "skill";
    return {
      method: "Skill",
      endpoint: skillName,
      detail: input ? JSON.stringify(input, null, 2) : "",
      color: "bg-violet-600",
      icon: IconSparkles,
    };
  }

  // MCP infra tools
  if (msg.toolName === "mcp__mini-infra-infra__api_request") {
    const method = ((input?.method as string) ?? "GET").toUpperCase();
    const apiPath = (input?.path as string) ?? "";
    return {
      method,
      endpoint: apiPath,
      detail: input ? JSON.stringify(input, null, 2) : "",
      color: methodColor(method),
      icon: IconApi,
    };
  }

  if (msg.toolName === "mcp__mini-infra-infra__list_docs") {
    const category = (input?.category as string) ?? "";
    return {
      method: "List Docs",
      endpoint: category,
      detail: input ? JSON.stringify(input, null, 2) : "",
      color: "bg-emerald-600",
      icon: IconFolderOpen,
    };
  }

  if (msg.toolName === "mcp__mini-infra-infra__read_doc") {
    const docPath = (input?.path as string) ?? "";
    return {
      method: "Read Doc",
      endpoint: docPath,
      detail: input ? JSON.stringify(input, null, 2) : "",
      color: "bg-emerald-600",
      icon: IconFileText,
    };
  }

  // Grep tool
  if (msg.toolName === "Grep") {
    const pattern = (input?.pattern as string) ?? "";
    return {
      method: "GREP",
      endpoint: pattern.slice(0, 80),
      detail: JSON.stringify(input, null, 2),
      color: "bg-cyan-600",
      icon: IconSearch,
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
  const { method, endpoint, icon: Icon } = parseToolDisplay(msg);
  const input = msg.input as Record<string, unknown> | undefined;
  const detail = input ? JSON.stringify(input, null, 2) : "";

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] hover:bg-muted/50 transition-colors text-left text-muted-foreground">
        <IconChevronRight className="size-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90" />
        {Icon && <Icon className="size-3 shrink-0" />}
        <span className="italic shrink-0">{method}</span>
        {endpoint && (
          <span className="truncate font-mono opacity-70">{endpoint}</span>
        )}
        {msg.output === undefined && (
          <span className="ml-auto shrink-0 size-1.5 rounded-full bg-amber-500 animate-pulse" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-0.5 space-y-0.5 ml-5">
        {detail && (
          <pre className="overflow-x-auto rounded border bg-muted/30 px-2 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-all">
            {detail}
          </pre>
        )}
        {msg.output !== undefined && (
          <pre className="overflow-x-auto rounded border bg-muted/30 px-2 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-48">
            {msg.output}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThinkingBlock({
  msg,
  tools,
}: {
  msg: ChatMessageThinking;
  tools?: ChatMessageToolUse[];
}) {
  const content = msg.redacted
    ? msg.content || "Thinking content is redacted."
    : msg.content;

  // Track whether the user has explicitly collapsed the block. While the
  // message is still streaming we always show it (auto-open).
  const [userCollapsed, setUserCollapsed] = useState(false);
  const isOpen = msg.status === "streaming" ? true : !userCollapsed;

  // Capture the moment the message completes so we can show a duration.
  // We use useEffectEvent so the setState is not inside the reactive body,
  // and so Date.now() is called from an event callback rather than during
  // render (which would violate react-hooks/purity).
  const [duration, setDuration] = useState<number | null>(null);
  const onStatusChange = useEffectEvent(() => {
    if (msg.status === "streaming") {
      // Reset duration if the message flips back to streaming.
      if (duration !== null) setDuration(null);
    } else if (duration === null) {
      setDuration(
        Math.max(1, Math.round((Date.now() - msg.timestamp) / 1000)),
      );
    }
  });
  useEffect(() => {
    onStatusChange();
  }, [msg.status]);

  return (
    <div>
      <button
        onClick={() => setUserCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] hover:bg-muted/50 transition-colors text-left text-muted-foreground"
      >
        <IconChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        {msg.status === "streaming" ? (
          <>
            <span className="italic">Thinking</span>
            <span className="ml-auto shrink-0 size-1.5 rounded-full bg-amber-500 animate-pulse" />
          </>
        ) : (
          <span className="italic">
            {msg.redacted
              ? "Thought (redacted)"
              : `Thought${duration ? ` for ${duration}s` : ""}`}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="mt-0.5 animate-in slide-in-from-top-1 duration-200">
          <pre className="overflow-x-auto rounded border bg-muted/50 px-2 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
            {content || "..."}
          </pre>
        </div>
      )}
      {tools && tools.length > 0 && (
        <div className="ml-4 pl-2 border-l border-border/50 mt-0.5 space-y-0.5">
          {tools.map((tool) => (
            <MessageBubble key={tool.id} msg={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  switch (msg.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-[13px] text-primary-foreground whitespace-pre-wrap">
            {msg.content}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="text-[13px]">
          <DocContent
            content={msg.content}
            className={chatMarkdownClasses}
          />
        </div>
      );

    case "tool_use":
      if (msg.toolName === "Skill") {
        const skillName =
          (msg.input as Record<string, unknown> | undefined)?.skill as
            | string
            | undefined;
        return (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground italic">
            <IconSparkles className="size-3 shrink-0" />
            <span>Skill</span>
            {skillName && (
              <span className="font-mono not-italic opacity-70 truncate">
                {skillName}
              </span>
            )}
          </div>
        );
      }
      if (msg.toolName === "mcp__mini-infra-ui__get_current_page") {
        return (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground italic">
            <IconEye className="size-3 shrink-0" />
            Reading page
            {msg.output === undefined && (
              <span className="ml-auto shrink-0 size-1.5 rounded-full bg-amber-500 animate-pulse" />
            )}
          </div>
        );
      }
      if (msg.toolName === "mcp__mini-infra-infra__api_request") {
        const input = msg.input as Record<string, unknown> | undefined;
        const method = ((input?.method as string) ?? "GET").toUpperCase();
        const apiPath = (input?.path as string) ?? "";
        return (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground italic">
            <IconApi className="size-3 shrink-0" />
            {apiPath ? (
              <>
                <span>{method}</span>
                <span className="font-mono not-italic opacity-70 truncate">
                  {apiPath}
                </span>
              </>
            ) : (
              <span>Calling API</span>
            )}
            {msg.output === undefined && (
              <span className="ml-auto shrink-0 size-1.5 rounded-full bg-amber-500 animate-pulse" />
            )}
          </div>
        );
      }
      return <ToolUseBlock msg={msg} />;

    case "thinking":
      return <ThinkingBlock msg={msg} />;

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

/**
 * Group consecutive thinking → tool_use messages so tool calls can be
 * rendered nested under the thinking block that preceded them.
 */
type MessageGroup =
  | { type: "thinking-group"; thinking: ChatMessageThinking; tools: ChatMessageToolUse[] }
  | { type: "single"; msg: ChatMessage };

function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "thinking") {
      const tools: ChatMessageToolUse[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool_use") {
        tools.push(messages[j] as ChatMessageToolUse);
        j++;
      }
      groups.push({
        type: "thinking-group",
        thinking: msg as ChatMessageThinking,
        tools,
      });
      i = j;
    } else {
      groups.push({ type: "single", msg });
      i++;
    }
  }
  return groups;
}

export function AgentChatMessages() {
  const { messages, streamingText } = useAgentChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const grouped = useMemo(() => groupMessages(messages), [messages]);

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
      className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
    >
      {messages.length === 0 && !streamingText && <AgentChatWelcome />}

      {grouped.map((group) =>
        group.type === "thinking-group" ? (
          <ThinkingBlock
            key={group.thinking.id}
            msg={group.thinking}
            tools={group.tools.length > 0 ? group.tools : undefined}
          />
        ) : (
          <MessageBubble key={group.msg.id} msg={group.msg} />
        ),
      )}

      {streamingText && (
        <div className="text-[13px]">
          <DocContent
            content={streamingText}
            className={chatMarkdownClasses}
          />
          <span className="inline-block w-1.5 h-4 ml-0.5 bg-foreground/70 animate-pulse align-text-bottom" />
        </div>
      )}
    </div>
  );
}
