import { useEffect, useRef, useState } from "react";
import { IconPlugConnected, IconPlugConnectedX, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useAgentSidecarTaskStream, type SSEEvent } from "@/hooks/use-agent-sidecar";

interface TaskStreamViewerProps {
  taskId: string;
  isRunning: boolean;
}

function ToolCallEntry({ event, resultEvent }: { event: SSEEvent; resultEvent?: SSEEvent }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = (event.data.tool as string) ?? "unknown";
  const input = event.data.input as Record<string, unknown> | undefined;

  return (
    <div className="border rounded-md p-3 space-y-2">
      <button
        className="flex items-center gap-2 w-full text-left text-sm font-medium"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <IconChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <IconChevronRight className="h-4 w-4 shrink-0" />
        )}
        <Badge variant="outline" className="font-mono text-xs">
          {toolName}
        </Badge>
        {resultEvent && (
          <span className="text-xs text-muted-foreground ml-auto">completed</span>
        )}
      </button>
      {expanded && input && (
        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {expanded && resultEvent && (
        <div className="text-xs text-muted-foreground border-t pt-2 mt-2">
          <pre className="whitespace-pre-wrap overflow-x-auto">
            {typeof resultEvent.data.output === "string"
              ? resultEvent.data.output
              : JSON.stringify(resultEvent.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function TaskStreamViewer({ taskId, isRunning }: TaskStreamViewerProps) {
  const { events, isConnected, error } = useAgentSidecarTaskStream(taskId, isRunning);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Build a map of tool_result events keyed by index
  const toolResultMap = new Map<number, SSEEvent>();
  let toolCallIndex = 0;
  const toolCallIndices: number[] = [];
  for (const event of events) {
    if (event.type === "tool_call") {
      toolCallIndices.push(toolCallIndex);
      toolCallIndex++;
    } else if (event.type === "tool_result") {
      // Pair with the most recent tool_call that doesn't have a result yet
      const lastUnpairedIdx = toolCallIndices.find((idx) => !toolResultMap.has(idx));
      if (lastUnpairedIdx !== undefined) {
        toolResultMap.set(lastUnpairedIdx, event);
      }
    }
  }

  let currentToolIdx = 0;

  return (
    <div className="space-y-3">
      {/* Connection indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isConnected ? (
          <>
            <IconPlugConnected className="h-3.5 w-3.5 text-green-500" />
            <span>Connected to stream</span>
          </>
        ) : isRunning ? (
          <>
            <IconPlugConnectedX className="h-3.5 w-3.5 text-yellow-500" />
            <span>Connecting...</span>
          </>
        ) : (
          <>
            <IconPlugConnectedX className="h-3.5 w-3.5" />
            <span>Stream closed</span>
          </>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{error}</AlertDescription>
        </Alert>
      )}

      {/* Events */}
      <div className="space-y-2 max-h-[600px] overflow-y-auto">
        {events.map((event, i) => {
          if (event.type === "status") {
            return (
              <p key={i} className="text-xs text-muted-foreground">
                {(event.data.message as string) ?? JSON.stringify(event.data)}
              </p>
            );
          }
          if (event.type === "tool_call") {
            const idx = currentToolIdx++;
            return <ToolCallEntry key={i} event={event} resultEvent={toolResultMap.get(idx)} />;
          }
          if (event.type === "tool_result") {
            // Already shown alongside tool_call
            return null;
          }
          if (event.type === "text") {
            return (
              <div key={i} className="text-sm whitespace-pre-wrap">
                {(event.data.text as string) ?? JSON.stringify(event.data)}
              </div>
            );
          }
          if (event.type === "complete") {
            return (
              <Alert key={i} className="border-green-500 bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300">
                <AlertDescription>Task completed successfully</AlertDescription>
              </Alert>
            );
          }
          if (event.type === "error") {
            return (
              <Alert key={i} variant="destructive">
                <AlertDescription>
                  {(event.data.error as string) ?? JSON.stringify(event.data)}
                </AlertDescription>
              </Alert>
            );
          }
          return null;
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
