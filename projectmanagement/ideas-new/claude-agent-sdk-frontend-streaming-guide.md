# Claude Agent SDK — Frontend Streaming Implementation Guide

## Overview

This document covers the complete pattern for consuming streaming messages from the Claude Agent SDK in a React frontend, relayed via an Express backend. It covers SDK message types, streaming architecture, session management, and UI rendering patterns.

---

## 1. Architecture Decision: SSE + REST vs WebSocket

| Concern | SSE + REST | WebSocket |
|---------|-----------|-----------|
| Server-to-client streaming | Native (EventSource) | Native |
| Client-to-server messages | Separate POST requests | Same connection |
| Auto-reconnection | Built into EventSource | Must implement manually |
| Proxy/HAProxy compatibility | Better (regular HTTP) | Requires upgrade support |
| Connection limits | 6 per origin (HTTP/1.1) | No practical limit |
| Implementation complexity | Simpler server, split client | More complex server, unified client |

**Recommendation for Mini Infra: SSE + REST**

Mini Infra already uses SSE for deployment logs and doesn't currently have WebSocket infrastructure. The agent's interaction model (user sends message, waits for streamed response) maps cleanly to `POST` to send + `SSE` to receive. Multi-turn conversation is handled by a server-side `MessageQueue` that the SSE stream consumes.

---

## 2. SDK Message Types — What the Frontend Must Handle

The SDK emits an `SDKMessage` union type. Not all types need UI rendering. Here's the complete list, categorized by frontend relevance:

### 2.1 Messages the Frontend MUST Render

#### `SDKSystemMessage` — Session initialization (first message)

```typescript
{
  type: "system",
  subtype: "init",
  session_id: string,       // Store this for session resumption
  model: string,            // e.g. "claude-sonnet-4-6"
  tools: string[],          // Available tools
  uuid: string,
  claude_code_version: string,
  cwd: string,
  permissionMode: string,
}
```

**Frontend action:** Store `session_id`. Optionally show model/tool info.

#### `SDKAssistantMessage` — Complete assistant response

```typescript
{
  type: "assistant",
  uuid: string,
  session_id: string,
  parent_tool_use_id: string | null,  // non-null = from a subagent
  error?: "authentication_failed" | "billing_error" | "rate_limit"
        | "invalid_request" | "server_error" | "unknown",
  message: {
    id: string,
    role: "assistant",
    model: string,
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | null,
    usage: { input_tokens: number, output_tokens: number },
    content: ContentBlock[]  // THE KEY FIELD — see section 2.2
  }
}
```

**Frontend action:** Render each content block in `message.content`. This is the primary message type for displaying responses.

#### `SDKPartialAssistantMessage` — Token-by-token streaming

Only emitted when `includePartialMessages: true` is set on the backend.

```typescript
{
  type: "stream_event",
  uuid: string,
  session_id: string,
  parent_tool_use_id: string | null,
  event: BetaRawMessageStreamEvent  // See section 3
}
```

**Frontend action:** Accumulate text deltas for real-time typing effect. Clear when the full `assistant` message arrives.

#### `SDKResultMessage` — Query completion

```typescript
// Success case
{
  type: "result",
  subtype: "success",
  session_id: string,
  result: string,            // Final text result
  duration_ms: number,
  total_cost_usd: number,
  num_turns: number,
  usage: { input_tokens: number, output_tokens: number },
  is_error: false
}

// Error cases
{
  type: "result",
  subtype: "error_max_turns" | "error_during_execution"
         | "error_max_budget_usd",
  session_id: string,
  errors: string[],
  is_error: true,
  duration_ms: number,
  total_cost_usd: number,
}
```

**Frontend action:** Mark conversation as complete. Show cost/duration if desired. Show errors if `is_error`.

### 2.2 Content Block Types (inside `SDKAssistantMessage.message.content`)

The `content` array contains blocks of these types:

```typescript
type ContentBlock =
  | { type: "text", text: string }
  | { type: "tool_use", id: string, name: string, input: Record<string, unknown> }
  | { type: "thinking", thinking: string }
```

**Text blocks** — The assistant's natural language response. Render as markdown.

**Tool use blocks** — The assistant invoked a tool. For the Mini Infra agent, this will always be `Bash` with a `curl` command:

```json
{
  "type": "tool_use",
  "id": "toolu_abc123",
  "name": "Bash",
  "input": {
    "command": "curl -s -H \"x-api-key: mk_agent_...\" http://localhost:5000/api/containers"
  }
}
```

**Thinking blocks** — Extended thinking content (if enabled). Usually hidden or shown in a collapsible section.

### 2.3 Messages the Frontend Should Handle (but not prominently render)

#### `SDKUserMessage` — Echoed user messages

```typescript
{
  type: "user",
  session_id: string,
  message: { role: "user", content: string | ContentBlock[] },
  parent_tool_use_id: string | null,
  isSynthetic?: boolean,     // true = tool result, not actual user input
  tool_use_result?: unknown  // The tool's output
}
```

When `isSynthetic` is true, this contains the result of a tool call (e.g., the curl response). The frontend can use `tool_use_result` to show the output inside a collapsible tool block.

#### `SDKCompactBoundaryMessage` — Context window compaction

```typescript
{
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger: "manual" | "auto", pre_tokens: number }
}
```

**Frontend action:** Can be ignored or shown as a subtle divider.

### 2.4 Messages the Frontend Can Ignore

These are informational or internal and don't need UI rendering:

- `SDKStatusMessage` — Internal status updates
- `SDKHookStartedMessage` / `SDKHookProgressMessage` / `SDKHookResponseMessage` — Hook lifecycle
- `SDKToolProgressMessage` — Tool execution progress
- `SDKAuthStatusMessage` — Authentication status
- `SDKTaskNotificationMessage` / `SDKTaskStartedMessage` / `SDKTaskProgressMessage` — Subagent tasks
- `SDKFilesPersistedEvent` — File checkpoint events
- `SDKToolUseSummaryMessage` — Tool use summary
- `SDKRateLimitEvent` — Rate limit info
- `SDKPromptSuggestionMessage` — Suggested follow-up prompts (could be useful for UX)

---

## 3. Streaming Events in Detail (`stream_event`)

When `includePartialMessages: true`, the SDK emits `stream_event` messages between full `assistant` messages. The `event` field contains Anthropic API streaming events that follow this lifecycle:

### 3.1 Event Flow for a Single Assistant Turn

```
message_start           → Message object with empty content array
content_block_start     → New block beginning (index 0, 1, 2, ...)
content_block_delta     → Incremental text/JSON for that block (many of these)
content_block_delta     → ...
content_block_stop      → Block at index N is complete
content_block_start     → Next block begins (if multiple blocks)
content_block_delta     → ...
content_block_stop      → ...
message_delta           → Top-level changes (stop_reason, usage)
message_stop            → Message is finished
```

### 3.2 Delta Types by Content Block

**For text blocks:**
```typescript
// content_block_start
{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }

// content_block_delta (many)
{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here " } }
{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "is my " } }
{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer." } }
```

**For tool_use blocks:**
```typescript
// content_block_start
{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_abc", name: "Bash" } }

// content_block_delta (partial JSON, must accumulate)
{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"com" } }
{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "mand\":" } }
{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " \"curl ...\"}" } }

// Parse the accumulated JSON at content_block_stop
```

**For thinking blocks:**
```typescript
// content_block_delta
{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I need to..." } }
```

### 3.3 Frontend State Machine for Partial Messages

```typescript
interface StreamingState {
  // Current content blocks being built
  blocks: Map<number, {
    type: "text" | "tool_use" | "thinking";
    content: string;              // Accumulated text/thinking
    toolName?: string;            // For tool_use blocks
    toolId?: string;              // For tool_use blocks
    partialJson?: string;         // Accumulated JSON for tool_use input
  }>;
  // Whether we're actively receiving stream events
  isStreaming: boolean;
}

function processStreamEvent(state: StreamingState, event: BetaRawMessageStreamEvent): StreamingState {
  switch (event.type) {
    case "content_block_start":
      state.blocks.set(event.index, {
        type: event.content_block.type,
        content: "",
        toolName: event.content_block.type === "tool_use" ? event.content_block.name : undefined,
        toolId: event.content_block.type === "tool_use" ? event.content_block.id : undefined,
        partialJson: event.content_block.type === "tool_use" ? "" : undefined,
      });
      break;

    case "content_block_delta":
      const block = state.blocks.get(event.index);
      if (!block) break;
      if (event.delta.type === "text_delta") {
        block.content += event.delta.text;
      } else if (event.delta.type === "input_json_delta") {
        block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
      } else if (event.delta.type === "thinking_delta") {
        block.content += event.delta.thinking;
      }
      break;

    case "content_block_stop":
      // Block is complete — could parse tool JSON here
      const stoppedBlock = state.blocks.get(event.index);
      if (stoppedBlock?.type === "tool_use" && stoppedBlock.partialJson) {
        try {
          stoppedBlock.content = JSON.stringify(JSON.parse(stoppedBlock.partialJson), null, 2);
        } catch { /* leave as raw string */ }
      }
      break;

    case "message_stop":
      state.isStreaming = false;
      break;
  }
  return { ...state };
}
```

---

## 4. Backend SSE Relay Pattern

### 4.1 MessageQueue — AsyncIterable for Multi-Turn

The SDK's streaming input mode expects an `AsyncIterable<SDKUserMessage>`. This class bridges HTTP requests to the SDK:

```typescript
// server/src/services/agent-message-queue.ts

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class AgentMessageQueue {
  private messages: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private closed = false;

  push(content: string): void {
    const msg: SDKUserMessage = {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
    };

    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<SDKUserMessage>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close(): void {
    this.closed = true;
    // Resolve any waiting promise with a dummy to unblock
    if (this.waiting) {
      this.waiting({
        type: "user",
        session_id: "",
        message: { role: "user", content: "" },
        parent_tool_use_id: null,
      });
      this.waiting = null;
    }
  }
}
```

### 4.2 Express SSE Endpoint

```typescript
// server/src/routes/agent.ts (SSE streaming portion)

router.get("/stream/:sessionId", requireSessionOrApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const session = agentService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",   // Disable nginx/HAProxy buffering
  });

  // Heartbeat to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  let eventId = 0;

  const sendEvent = (type: string, data: unknown) => {
    eventId++;
    res.write(`id: ${eventId}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    session.removeSubscriber(res);
  });

  // Subscribe this SSE connection to session events
  session.addSubscriber(res, sendEvent);
});
```

### 4.3 POST Endpoint for Sending Messages

```typescript
// server/src/routes/agent.ts (message sending portion)

router.post("/sessions/:sessionId/messages", requireSessionOrApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { message } = req.body;

  const session = agentService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Push the message into the queue — the SDK will pick it up
  session.messageQueue.push(message);
  res.json({ success: true });
});
```

### 4.4 Agent Session Lifecycle

```
1. POST /api/agent/sessions         → Creates session, starts query()
2. GET  /api/agent/stream/:id       → SSE connection, subscribes to events
3. POST /api/agent/sessions/:id/messages → Pushes follow-up messages
4. ... (messages flow through SSE) ...
5. DELETE /api/agent/sessions/:id   → Closes session, terminates query()
```

### 4.5 Message Processing on the Backend

The backend iterates over `query()` and transforms SDK messages into simplified SSE events:

```typescript
// Simplified event types sent to the frontend
type FrontendEvent =
  | { type: "init"; sessionId: string; model: string }
  | { type: "text"; content: string; uuid: string }
  | { type: "text_delta"; content: string }          // Partial streaming
  | { type: "tool_start"; toolName: string; toolId: string }
  | { type: "tool_input_delta"; toolId: string; partialJson: string }
  | { type: "tool_use"; toolName: string; toolId: string; input: unknown }
  | { type: "tool_result"; toolId: string; output: unknown }
  | { type: "thinking"; content: string }
  | { type: "error"; message: string; code?: string }
  | { type: "result"; success: boolean; cost?: number; duration?: number; turns?: number }
  | { type: "done" }
```

**Processing logic:**

```typescript
for await (const message of queryResult) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        sendEvent("init", {
          sessionId: message.session_id,
          model: message.model,
        });
      }
      break;

    case "stream_event": {
      const event = message.event;
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        sendEvent("tool_start", {
          toolName: event.content_block.name,
          toolId: event.content_block.id,
        });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          sendEvent("text_delta", { content: event.delta.text });
        } else if (event.delta.type === "input_json_delta") {
          sendEvent("tool_input_delta", {
            toolId: /* tracked from content_block_start */,
            partialJson: event.delta.partial_json,
          });
        }
      }
      break;
    }

    case "assistant": {
      // Full message — extract content blocks
      for (const block of message.message.content) {
        if (block.type === "text") {
          sendEvent("text", { content: block.text, uuid: message.uuid });
        } else if (block.type === "tool_use") {
          sendEvent("tool_use", {
            toolName: block.name,
            toolId: block.id,
            input: block.input,
          });
        }
      }
      break;
    }

    case "user": {
      // Synthetic user message = tool result
      if (message.isSynthetic && message.tool_use_result) {
        sendEvent("tool_result", {
          toolId: /* correlate with previous tool_use */,
          output: message.tool_use_result,
        });
      }
      break;
    }

    case "result":
      sendEvent("result", {
        success: message.subtype === "success",
        cost: message.total_cost_usd,
        duration: message.duration_ms,
        turns: message.num_turns,
      });
      break;
  }
}
```

---

## 5. Frontend React Implementation

### 5.1 Chat Message Types

```typescript
// client/src/types/agent-chat.ts

export type ChatMessage =
  | { type: "user"; content: string; timestamp: Date }
  | { type: "assistant"; content: string; uuid: string; timestamp: Date }
  | { type: "tool_use"; toolName: string; toolId: string; input: unknown; output?: unknown; timestamp: Date }
  | { type: "thinking"; content: string; timestamp: Date }
  | { type: "error"; message: string; timestamp: Date }
  | { type: "result"; success: boolean; cost?: number; duration?: number; turns?: number; timestamp: Date };

export interface AgentSession {
  id: string;
  sessionId?: string;  // SDK session ID
  model?: string;
  status: "idle" | "connecting" | "streaming" | "waiting" | "error" | "done";
}
```

### 5.2 useAgentChat Hook

```typescript
// client/src/hooks/use-agent-chat.ts

import { useState, useCallback, useRef, useEffect } from "react";
import type { ChatMessage, AgentSession } from "@/types/agent-chat";

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Create a new session and start streaming
  const startSession = useCallback(async (initialMessage: string) => {
    // 1. Create session on backend
    const res = await fetch("/api/agent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: initialMessage }),
    });
    const { sessionId } = await res.json();

    // 2. Add user message to local state
    setMessages([{ type: "user", content: initialMessage, timestamp: new Date() }]);
    setSession({ id: sessionId, status: "connecting" });

    // 3. Connect SSE
    connectSSE(sessionId);
  }, []);

  // Connect to SSE stream
  const connectSSE = useCallback((sessionId: string) => {
    const es = new EventSource(`/api/agent/stream/${sessionId}`);
    eventSourceRef.current = es;

    es.addEventListener("init", (e) => {
      const data = JSON.parse(e.data);
      setSession((prev) => prev && {
        ...prev,
        sessionId: data.sessionId,
        model: data.model,
        status: "streaming",
      });
    });

    es.addEventListener("text_delta", (e) => {
      const data = JSON.parse(e.data);
      setStreamingText((prev) => prev + data.content);
    });

    es.addEventListener("text", (e) => {
      const data = JSON.parse(e.data);
      // Full text arrived — replace streaming text with final message
      setStreamingText("");
      setMessages((prev) => [
        ...prev,
        { type: "assistant", content: data.content, uuid: data.uuid, timestamp: new Date() },
      ]);
    });

    es.addEventListener("tool_start", (e) => {
      const data = JSON.parse(e.data);
      setActiveToolId(data.toolId);
      setMessages((prev) => [
        ...prev,
        { type: "tool_use", toolName: data.toolName, toolId: data.toolId, input: {}, timestamp: new Date() },
      ]);
    });

    es.addEventListener("tool_use", (e) => {
      const data = JSON.parse(e.data);
      // Update the tool_use message with full input
      setMessages((prev) =>
        prev.map((m) =>
          m.type === "tool_use" && m.toolId === data.toolId
            ? { ...m, input: data.input }
            : m
        )
      );
    });

    es.addEventListener("tool_result", (e) => {
      const data = JSON.parse(e.data);
      // Attach output to the tool_use message
      setMessages((prev) =>
        prev.map((m) =>
          m.type === "tool_use" && m.toolId === data.toolId
            ? { ...m, output: data.output }
            : m
        )
      );
      setActiveToolId(null);
    });

    es.addEventListener("error", (e) => {
      const data = JSON.parse(e.data);
      setMessages((prev) => [
        ...prev,
        { type: "error", message: data.message, timestamp: new Date() },
      ]);
      setSession((prev) => prev && { ...prev, status: "error" });
    });

    es.addEventListener("result", (e) => {
      const data = JSON.parse(e.data);
      setMessages((prev) => [
        ...prev,
        { type: "result", ...data, timestamp: new Date() },
      ]);
      setSession((prev) => prev && { ...prev, status: "done" });
    });

    es.addEventListener("done", () => {
      es.close();
      setSession((prev) => prev && { ...prev, status: "idle" });
    });

    // Connection-level error (network failure, etc.)
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setSession((prev) => prev && { ...prev, status: "error" });
      }
    };
  }, []);

  // Send a follow-up message
  const sendMessage = useCallback(async (content: string) => {
    if (!session?.id) return;

    setMessages((prev) => [...prev, { type: "user", content, timestamp: new Date() }]);
    setStreamingText("");
    setSession((prev) => prev && { ...prev, status: "streaming" });

    await fetch(`/api/agent/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: content }),
    });
  }, [session?.id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  return {
    messages,
    session,
    streamingText,
    activeToolId,
    startSession,
    sendMessage,
  };
}
```

### 5.3 Component Structure

```
agent-chat-panel.tsx          — Main container (slide-out sidebar)
├── agent-chat-header.tsx     — Title bar with model info, close button
├── agent-chat-messages.tsx   — Scrollable message list
│   ├── user-message.tsx      — User message bubble
│   ├── assistant-message.tsx — Assistant text (with markdown rendering)
│   ├── tool-use-block.tsx    — Collapsible curl command + response
│   ├── thinking-block.tsx    — Collapsible thinking content
│   ├── streaming-text.tsx    — In-progress text with cursor animation
│   └── result-summary.tsx    — Cost, duration, turn count
├── agent-chat-input.tsx      — Text input + send button
└── agent-status-bar.tsx      — Connection status indicator
```

### 5.4 Tool Use Block — Rendering curl Commands

Since the Mini Infra agent only uses `Bash` with `curl`, the tool block should extract and display the curl command cleanly:

```tsx
// Simplified tool use block
function ToolUseBlock({ toolName, input, output }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);

  // Extract the curl command for display
  const command = (input as { command?: string })?.command ?? JSON.stringify(input);

  // Parse the curl URL for a clean summary
  const urlMatch = command.match(/http:\/\/localhost:5000(\/api\/[^\s"']+)/);
  const endpoint = urlMatch ? urlMatch[1] : command;

  // Determine HTTP method from curl flags
  const method = command.includes("-X DELETE") ? "DELETE"
    : command.includes("-X PUT") ? "PUT"
    : command.includes("-X POST") || command.includes("-d ") ? "POST"
    : "GET";

  return (
    <div className="rounded-md border my-2">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 p-2 w-full text-left text-sm">
        <ChevronIcon expanded={expanded} />
        <span className="font-mono text-xs">
          <span className={methodColor(method)}>{method}</span> {endpoint}
        </span>
        {output ? <CheckIcon /> : <Spinner />}
      </button>
      {expanded && (
        <div className="border-t p-2 bg-muted/50">
          <pre className="text-xs font-mono whitespace-pre-wrap">{command}</pre>
          {output && (
            <>
              <div className="text-xs text-muted-foreground mt-2 mb-1">Response:</div>
              <pre className="text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto">
                {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

### 5.5 Streaming Text with Cursor

```tsx
function StreamingText({ text }: { text: string }) {
  if (!text) return null;

  return (
    <div className="flex items-start gap-2 mb-4">
      <div className="bg-muted rounded-lg p-3 max-w-[85%]">
        <div className="prose prose-sm dark:prose-invert whitespace-pre-wrap">
          {text}
          <span className="inline-block w-2 h-4 bg-foreground/70 animate-pulse ml-0.5" />
        </div>
      </div>
    </div>
  );
}
```

---

## 6. Session Resumption

### 6.1 Backend Pattern

```typescript
// Resume an existing session
router.post("/sessions/:sessionId/resume", requireSessionOrApiKey, async (req, res) => {
  const { sessionId } = req.params;

  // Start a new query with resume option
  const queryResult = query({
    prompt: messageQueue,
    options: {
      resume: sessionId,        // SDK session ID (not your internal ID)
      includePartialMessages: true,
      allowedTools: ["Bash"],
      // ... other options
    },
  });

  // The SDK replays previous messages, then waits for new input
  // The frontend will see SDKUserMessageReplay messages during replay
});
```

### 6.2 Frontend Pattern

When a user returns to a previous conversation:

1. Load saved messages from your database (for instant display)
2. Call `POST /api/agent/sessions/:id/resume`
3. Connect SSE to receive new events
4. During replay, SDK sends `SDKUserMessageReplay` (type `"user"`, `isReplay: true`) messages — these can be ignored since you already loaded history from the database

---

## 7. Error Handling

### 7.1 Error Categories

| Source | Error Type | Frontend Action |
|--------|-----------|----------------|
| SDK | `SDKAssistantMessage.error` | Show inline error with retry button |
| SDK | `SDKResultMessage.subtype = "error_*"` | Show error banner at bottom of chat |
| SSE | `EventSource.onerror` | Show reconnection UI |
| REST | HTTP 4xx/5xx on POST | Show toast notification |
| Hook | `permissionDecision: "deny"` | Agent self-reports denial in its text response |

### 7.2 Rate Limit Handling

The SDK emits `SDKRateLimitEvent` when rate limited. The backend should relay this:

```typescript
sendEvent("rate_limit", { retryAfterMs: event.retry_after_ms });
```

The frontend should show a countdown or "Waiting for rate limit..." indicator.

---

## 8. Summary of the Full Message Flow

```
User types message in chat input
        │
        ▼
POST /api/agent/sessions (or /sessions/:id/messages for follow-up)
        │
        ▼
Backend pushes to MessageQueue
        │
        ▼
SDK query() async generator picks up message
        │
        ▼
SDK processes (Claude API call, tool execution, etc.)
        │
        ▼
SDK emits SDKMessages via async generator
        │
        ▼
Backend transforms to simplified events, writes to SSE
        │
        ▼
EventSource receives events in browser
        │
        ▼
React hook processes events, updates state
        │
        ▼
Components re-render with new messages
```

---

## 9. Key Implementation Notes

1. **Always set `includePartialMessages: true`** on the backend for real-time streaming UX. Without it, responses appear all at once after Claude finishes thinking.

2. **The full `assistant` message always arrives** even with partial messages enabled. Use partial messages for the typing effect, then replace with the complete message when it arrives.

3. **Tool results come as synthetic user messages.** Match them to tool_use blocks by correlating `tool_use_id` fields.

4. **The API key is never exposed to the frontend.** The backend injects the Mini Infra API key into the system prompt and the Anthropic API key is only in the server environment.

5. **HAProxy/proxy considerations:** Set `X-Accel-Buffering: no` header and send heartbeat comments every 15 seconds to prevent proxy timeouts.

6. **One SSE connection per session.** Don't open multiple EventSource connections for the same session.

7. **Clean up on disconnect.** Always handle `req.on("close")` on the backend and `eventSource.close()` on the frontend to prevent orphaned SDK processes.
