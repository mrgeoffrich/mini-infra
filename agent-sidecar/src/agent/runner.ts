import { v4 as uuidv4 } from "uuid";
import { query, type SDKMessage } from "./sdk";
import { SessionStore } from "../session-store";
import { SSEEvent } from "../types";
import { buildSystemPrompt } from "./system-prompt";
import { summarizeOutput, type ToolResult } from "./tools";
import { createInfraToolsMcpServer } from "./infra-tools-mcp";
import { createUiToolsMcpServer } from "./ui-tools-mcp";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-4-6";
const AGENT_TIMEOUT_MS = parseInt(
  process.env.AGENT_TIMEOUT_MS ?? "300000",
  10,
);
const MAX_TOKENS = 16384;

// ---------------------------------------------------------------------------
// Tool result emitter type — used by MCP servers to emit tool_result SSE events
// ---------------------------------------------------------------------------

export type ToolResultEmitter = (toolName: string, result: ToolResult) => void;

// ---------------------------------------------------------------------------
// Agent runner — Agent SDK query()
// ---------------------------------------------------------------------------

export async function runSession(
  sessionId: string,
  store: SessionStore,
  initialMessage: string,
  sdkSessionId?: string,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session) {
    logger.error({ sessionId }, "Session not found when starting agent");
    return;
  }

  const systemPrompt = buildSystemPrompt();

  const timeoutHandle = setTimeout(() => {
    logger.warn({ sessionId }, "Session timed out");
    session.abortController.abort();
  }, AGENT_TIMEOUT_MS);

  // Track pending tool_use_ids from stream events so MCP handlers can emit
  // tool_result SSE events with the correct tool_use_id.
  const pendingToolUseIds: Array<{ toolUseId: string; plainName: string }> = [];

  // Tool result emitter — called from MCP handlers after tool execution.
  // Pops the matching pending tool_use_id and emits tool_result SSE.
  const toolResultEmitter: ToolResultEmitter = (toolName: string, result: ToolResult) => {
    // Find matching pending tool_use_id (first match by name)
    const idx = pendingToolUseIds.findIndex((p) => p.plainName === toolName);
    if (idx >= 0) {
      const { toolUseId } = pendingToolUseIds[idx];
      pendingToolUseIds.splice(idx, 1);
      emitSSE(store, sessionId, {
        type: "tool_result",
        data: {
          toolId: toolUseId,
          output: summarizeOutputText(result.content),
        },
      });
    }
  };

  // Create MCP servers per-session (UI tools need the session's broadcast/path)
  const infraMcpServer = createInfraToolsMcpServer(toolResultEmitter);
  const uiMcpServer = createUiToolsMcpServer(
    (event: SSEEvent) => emitSSE(store, sessionId, event),
    () => session.currentPath,
    toolResultEmitter,
  );

  // Emit init event
  emitSSE(store, sessionId, {
    type: "init",
    data: { sessionId, model: AGENT_MODEL },
  });

  let capturedSdkSessionId: string | null = sdkSessionId ?? null;
  let assistantUuid = uuidv4();

  // Track streaming state for SSE mapping
  const currentBlockTypes = new Map<number, string>();
  const pendingToolInputs = new Map<
    number,
    { id: string; name: string; inputJson: string }
  >();
  let isReplayingMessages = !!sdkSessionId; // Skip emitting replayed messages during resume

  try {
    const queryOptions: Record<string, unknown> = {
      model: AGENT_MODEL,
      maxTokens: MAX_TOKENS,
      systemPrompt,
      cwd: "/tmp/agent-work",
      mcpServers: {
        "mini-infra-infra": infraMcpServer,
        "mini-infra-ui": uiMcpServer,
      },
      allowedTools: [
        "mcp__mini-infra-infra__bash",
        "mcp__mini-infra-infra__mini_infra_api",
        "mcp__mini-infra-infra__read_file",
        "mcp__mini-infra-infra__write_file",
        "mcp__mini-infra-infra__list_docs",
        "mcp__mini-infra-infra__read_doc",
        "mcp__mini-infra-ui__highlight_element",
        "mcp__mini-infra-ui__navigate_to",
        "mcp__mini-infra-ui__get_current_page",
      ],
      permissionTool: async () => ({ behavior: "allow" as const }),
    };

    if (sdkSessionId) {
      queryOptions.resume = sdkSessionId;
    }

    const stream = query({
      prompt: initialMessage,
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });

    for await (const message of stream) {
      if (session.abortController.signal.aborted) {
        handleAbort(store, sessionId);
        return;
      }

      // Capture SDK session ID from the first message that has one
      if (
        !capturedSdkSessionId &&
        "session_id" in message &&
        typeof (message as Record<string, unknown>).session_id === "string"
      ) {
        capturedSdkSessionId = (message as Record<string, unknown>).session_id as string;
        // Re-emit init with the SDK session ID so the server can capture it
        emitSSE(store, sessionId, {
          type: "init",
          data: { sessionId, model: AGENT_MODEL, sdkSessionId: capturedSdkSessionId },
        });
      }

      // Handle message types from the Agent SDK
      const msgType = (message as Record<string, unknown>).type as string;

      switch (msgType) {
        case "stream_event": {
          // During resume, skip replayed events until we see fresh content
          if (isReplayingMessages) break;

          const event = (message as unknown as { event: Record<string, unknown> }).event;
          processStreamEvent(
            store,
            sessionId,
            { currentBlockTypes, pendingToolInputs, pendingToolUseIds },
            event,
            assistantUuid,
          );
          break;
        }

        case "assistant": {
          // A complete assistant message
          isReplayingMessages = false; // Any new assistant message means we're past replay

          const assistantMessage = message as {
            type: "assistant";
            message: {
              content: Array<{
                type: string;
                text?: string;
                thinking?: string;
                signature?: string;
              }>;
            };
          };
          assistantUuid = uuidv4();

          // Emit final content blocks
          if (assistantMessage.message) {
            emitFinalContentBlocks(
              store,
              sessionId,
              assistantMessage.message,
              assistantUuid,
            );
          }

          // Emit assistant_message_stop
          emitSSE(store, sessionId, {
            type: "assistant_message_stop",
            data: { assistantUuid },
          });

          // Reset block tracking for next turn
          currentBlockTypes.clear();
          pendingToolInputs.clear();

          store.incrementTurns(sessionId);
          break;
        }

        case "result": {
          isReplayingMessages = false;
          // Final result from the SDK
          const resultMsg = message as {
            type: "result";
            subtype: string;
            duration_ms?: number;
            num_turns?: number;
            total_cost_usd?: number;
          };
          if (resultMsg.subtype === "success") {
            store.completeSession(sessionId);
          } else {
            const errorMsg = (message as { error?: string }).error ?? "Agent query failed";
            store.failSession(sessionId, errorMsg);
            emitSSE(store, sessionId, {
              type: "error",
              data: { message: errorMsg },
            });
          }
          break;
        }

        case "system": {
          // Init or status message — capture model/session info
          isReplayingMessages = false;
          break;
        }

        case "user": {
          // Replayed user message during resume — skip
          break;
        }

        default:
          break;
      }
    }

    // If we didn't already transition to completed
    const currentSession = store.getSession(sessionId);
    if (currentSession?.status === "running") {
      store.completeSession(sessionId);
    }
  } catch (err: unknown) {
    if (session.abortController.signal.aborted) {
      handleAbort(store, sessionId);
      return;
    }

    const message =
      err instanceof Error ? err.message : "Unknown agent error";
    logger.error({ err, sessionId }, "Agent runner error");
    store.failSession(sessionId, message);
    emitSSE(store, sessionId, {
      type: "error",
      data: { message },
    });
  } finally {
    clearTimeout(timeoutHandle);

    // Emit result and done
    const finalSession = store.getSession(sessionId);
    emitSSE(store, sessionId, {
      type: "result",
      data: {
        success: finalSession?.status === "completed",
        cost: 0,
        duration: finalSession?.durationMs ?? 0,
        turns: finalSession?.turns ?? 0,
        sdkSessionId: capturedSdkSessionId,
      },
    });
    emitSSE(store, sessionId, { type: "done", data: {} });
  }
}

// ---------------------------------------------------------------------------
// Stream event processor (reused from raw SDK streaming events)
// ---------------------------------------------------------------------------

interface StreamState {
  currentBlockTypes: Map<number, string>;
  pendingToolInputs: Map<number, { id: string; name: string; inputJson: string }>;
  pendingToolUseIds: Array<{ toolUseId: string; plainName: string }>;
}

/**
 * Extract the plain tool name from an MCP-prefixed name.
 * e.g. "mcp__mini-infra-infra__bash" → "bash"
 */
function stripMcpPrefix(name: string): string {
  const parts = name.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : name;
}

function processStreamEvent(
  store: SessionStore,
  sessionId: string,
  state: StreamState,
  event: Record<string, unknown>,
  assistantUuid: string,
): void {
  const eventType = event.type as string;

  switch (eventType) {
    case "content_block_start": {
      const block = event.content_block as {
        type: string;
        id?: string;
        name?: string;
      };
      const index = event.index as number;
      state.currentBlockTypes.set(index, block.type);

      if (block.type === "tool_use") {
        const toolId = block.id!;
        const toolName = block.name!;
        state.pendingToolInputs.set(index, {
          id: toolId,
          name: toolName,
          inputJson: "",
        });
        emitSSE(store, sessionId, {
          type: "tool_start",
          data: {
            toolName,
            toolId,
          },
        });
      } else if (block.type === "thinking") {
        emitSSE(store, sessionId, {
          type: "thinking_start",
          data: { assistantUuid, blockIndex: index },
        });
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta as {
        type: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
      };
      const index = event.index as number;

      if (delta.type === "text_delta") {
        emitSSE(store, sessionId, {
          type: "text_delta",
          data: { content: delta.text ?? "" },
        });
      } else if (delta.type === "thinking_delta") {
        emitSSE(store, sessionId, {
          type: "thinking_delta",
          data: {
            assistantUuid,
            blockIndex: index,
            content: delta.thinking ?? "",
          },
        });
      } else if (delta.type === "signature_delta") {
        emitSSE(store, sessionId, {
          type: "thinking_signature",
          data: {
            assistantUuid,
            blockIndex: index,
            signature: delta.signature ?? "",
          },
        });
      } else if (delta.type === "input_json_delta") {
        const pending = state.pendingToolInputs.get(index);
        if (pending) {
          pending.inputJson += delta.partial_json ?? "";
        }
      }
      break;
    }

    case "content_block_stop": {
      const index = event.index as number;
      const blockType = state.currentBlockTypes.get(index);

      if (blockType === "tool_use") {
        const pending = state.pendingToolInputs.get(index);
        if (pending) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(pending.inputJson || "{}");
          } catch {
            // empty
          }
          emitSSE(store, sessionId, {
            type: "tool_use",
            data: {
              toolName: pending.name,
              toolId: pending.id,
              input,
            },
          });

          // Track pending tool_use_id for the MCP handler to emit tool_result
          state.pendingToolUseIds.push({
            toolUseId: pending.id,
            plainName: stripMcpPrefix(pending.name),
          });
        }
      }
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Emit final content blocks from a complete assistant message
// ---------------------------------------------------------------------------

function emitFinalContentBlocks(
  store: SessionStore,
  sessionId: string,
  message: {
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
    }>;
  },
  assistantUuid: string,
): void {
  for (const [blockIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      emitSSE(store, sessionId, {
        type: "text",
        data: { content: block.text ?? "", uuid: assistantUuid },
      });
    } else if (block.type === "thinking") {
      emitSSE(store, sessionId, {
        type: "thinking_complete",
        data: {
          assistantUuid,
          blockIndex,
          content: block.thinking ?? "",
          signature: block.signature,
        },
      });
    } else if (block.type === "redacted_thinking") {
      emitSSE(store, sessionId, {
        type: "thinking_redacted",
        data: {
          assistantUuid,
          blockIndex,
          content: "Thinking content is redacted.",
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitSSE(
  store: SessionStore,
  sessionId: string,
  event: SSEEvent,
): void {
  store.emitSSE(sessionId, event);
}

function handleAbort(store: SessionStore, sessionId: string): void {
  const currentSession = store.getSession(sessionId);
  if (currentSession?.status === "running") {
    store.cancelSession(sessionId);
  }
  emitSSE(store, sessionId, {
    type: "error",
    data: { message: "Session was cancelled" },
  });
}

function summarizeOutputText(text: string): string {
  if (text.length <= 200) return text;
  const lines = text.split("\n");
  if (lines.length > 10) {
    const head = lines.slice(0, 3).join("\n");
    const tail = lines.slice(-3).join("\n");
    return `${head}\n... (${lines.length} lines total) ...\n${tail}`;
  }
  return text.slice(0, 200) + "...";
}
