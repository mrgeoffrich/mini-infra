import { v4 as uuidv4 } from "uuid";
import { tappedQuery, type TapMessage } from "@mrgeoffrich/claude-agent-sdk-tap";
import { createHttpSink } from "@mrgeoffrich/claude-agent-sdk-tap/transport";
import { createFileSink } from "./file-sink";
import { TurnStore } from "../turn-store";
import { SSEEvent } from "../types";
import { buildSystemPrompt } from "./system-prompt";
import { checkBashSafety } from "./tools";
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
const AGENT_THINKING = (process.env.AGENT_THINKING ?? "adaptive") as
  | "adaptive"
  | "enabled"
  | "disabled";
const AGENT_EFFORT = (process.env.AGENT_EFFORT ?? "medium") as
  | "low"
  | "medium"
  | "high"
  | "max";

// ---------------------------------------------------------------------------
// Agent runner — Agent SDK query()
// ---------------------------------------------------------------------------

export async function runTurn(
  turnId: string,
  store: TurnStore,
): Promise<void> {
  const turn = store.getTurn(turnId);
  if (!turn) {
    logger.error({ turnId }, "Turn not found when starting agent");
    return;
  }

  const systemPrompt = buildSystemPrompt();

  const timeoutHandle = setTimeout(() => {
    logger.warn({ turnId }, "Turn timed out");
    turn.abortController.abort();
  }, AGENT_TIMEOUT_MS);

  // Create MCP servers per-turn (UI tools need the turn's broadcast/path)
  const infraMcpServer = createInfraToolsMcpServer();
  const uiMcpServer = createUiToolsMcpServer(
    (event: SSEEvent) => emitSSE(store, turnId, event),
    () => turn.currentPath,
  );

  // Emit init event
  emitSSE(store, turnId, {
    type: "init",
    data: { turnId, model: AGENT_MODEL },
  });

  let capturedClaudeSessionId: string | null = turn.claudeSessionId;
  let capturedCostUsd: number | null = null;
  let assistantUuid = uuidv4();

  // Track streaming state for SSE mapping
  const currentBlockTypes = new Map<number, string>();
  const pendingToolInputs = new Map<
    number,
    { id: string; name: string; inputJson: string }
  >();

  // Set up tap sinks outside try so they're accessible in finally
  const TAP_COLLECTOR_URL = process.env.TAP_COLLECTOR_URL;
  const tapHttpSink = TAP_COLLECTOR_URL
    ? createHttpSink(TAP_COLLECTOR_URL, {
        headers: process.env.TAP_COLLECTOR_AUTH
          ? { Authorization: process.env.TAP_COLLECTOR_AUTH }
          : undefined,
        batchSize: 10,
        flushIntervalMs: 2000,
        onError: (err: unknown) => logger.warn({ err }, "Tap HTTP sink error"),
      })
    : null;

  // Always log SDK messages to disk as NDJSON (one file per turn)
  const tapFileSink = createFileSink(turnId);

  try {
    const queryOptions: Record<string, unknown> = {
      model: AGENT_MODEL,
      systemPrompt,
      cwd: "/tmp/agent-work",
      abortController: turn.abortController,
      // Resume prior SDK session so follow-up messages retain conversation context
      ...(capturedClaudeSessionId ? { resume: capturedClaudeSessionId } : {}),
      // Load project skills from /app/.claude/skills/
      settingSources: ["project"],
      // Use the SDK's built-in tools instead of custom MCP tools
      tools: ["Bash", "Read", "Glob", "Grep", "Skill"],
      additionalDirectories: ["/app/docs"],
      // Domain-specific MCP servers (API calls, docs, UI guidance)
      mcpServers: {
        "mini-infra-infra": infraMcpServer,
        "mini-infra-ui": uiMcpServer,
      },
      // Auto-approve read-only and MCP tools; Bash goes through canUseTool
      allowedTools: [
        "Bash",
        "Read",
        "Glob",
        "Grep",
        "Skill",
        "mcp__mini-infra-infra__*",
        "mcp__mini-infra-ui__*",
      ],
      // Safety checks for Bash commands
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        if (toolName === "Bash") {
          const command = String(input.command ?? "");
          const violation = checkBashSafety(command);
          if (violation) {
            return { behavior: "deny" as const, message: `BLOCKED: ${violation}` };
          }
        }
        return { behavior: "allow" as const };
      },
      includePartialMessages: true,
      thinking:
        AGENT_THINKING === "disabled"
          ? { type: "disabled" as const }
          : AGENT_THINKING === "enabled"
            ? { type: "enabled" as const }
            : { type: "adaptive" as const },
      effort: AGENT_EFFORT,
    };

    const stream = tappedQuery(
      {
        prompt: turn.messageQueue,
        options: queryOptions as Parameters<typeof tappedQuery>[0]["options"],
      },
      {},
      {
        onMessage: (msg: TapMessage) => {
          tapFileSink.send(msg);
          if (tapHttpSink) {
            tapHttpSink.send(msg);
          }
        },
      },
    );

    for await (const message of stream) {
      if (turn.abortController.signal.aborted) {
        handleAbort(store, turnId);
        return;
      }

      // Handle message types from the Agent SDK
      const msgType = (message as Record<string, unknown>).type as string;

      switch (msgType) {
        case "stream_event": {
          const event = (message as unknown as { event: Record<string, unknown> }).event;
          processStreamEvent(
            store,
            turnId,
            { currentBlockTypes, pendingToolInputs },
            event,
            assistantUuid,
          );
          break;
        }

        case "assistant": {
          const assistantMessage = message as {
            type: "assistant";
            message: {
              content: Array<{
                type: string;
                text?: string;
                thinking?: string;
                signature?: string;
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }>;
            };
          };
          assistantUuid = uuidv4();

          // Emit final content blocks
          if (assistantMessage.message) {
            emitFinalContentBlocks(
              store,
              turnId,
              assistantMessage.message,
              assistantUuid,
            );
          }

          // Emit assistant_message_stop
          emitSSE(store, turnId, {
            type: "assistant_message_stop",
            data: { assistantUuid },
          });

          // Reset block tracking for next turn
          currentBlockTypes.clear();
          pendingToolInputs.clear();

          store.incrementTurns(turnId);
          break;
        }

        case "user": {
          // Skip replayed messages during resume
          if ((message as Record<string, unknown>).isReplay) break;

          // Extract tool results from synthetic user messages
          const userMsg = message as {
            type: "user";
            message?: { content?: unknown };
          };
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === "tool_result") {
                const resultContent = block.content;
                let output = "";
                if (typeof resultContent === "string") {
                  output = resultContent;
                } else if (Array.isArray(resultContent)) {
                  output = (resultContent as Array<{ type?: string; text?: string }>)
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .filter(Boolean)
                    .join("\n");
                }
                emitSSE(store, turnId, {
                  type: "tool_result",
                  data: {
                    toolId: block.tool_use_id as string,
                    output: summarizeOutputText(output),
                  },
                });
              }
            }
          }
          break;
        }

        case "result": {
          // Per-turn result from the SDK. With AsyncIterable prompt, "success"
          // means the agent finished the current message — not that the turn
          // is over. The turn ends when the queue closes (generator exits).
          const resultMsg = message as {
            type: "result";
            subtype: string;
            session_id?: string;
            duration_ms?: number;
            num_turns?: number;
            total_cost_usd?: number;
            errors?: string[];
          };

          // Capture the real Claude session ID so follow-up messages use it
          if (resultMsg.session_id) {
            capturedClaudeSessionId = resultMsg.session_id;
            turn.claudeSessionId = capturedClaudeSessionId;
            emitSSE(store, turnId, {
              type: "init",
              data: { turnId, model: AGENT_MODEL, sdkSessionId: capturedClaudeSessionId },
            });
          }
          if (resultMsg.total_cost_usd != null) {
            capturedCostUsd = resultMsg.total_cost_usd;
          }

          if (resultMsg.subtype !== "success") {
            const errorMsg = resultMsg.errors?.[0] ?? "Agent query failed";
            store.failTurn(turnId, errorMsg);
            emitSSE(store, turnId, {
              type: "error",
              data: { message: errorMsg },
            });
          }
          // On success: emit a turn-complete marker so the frontend knows the
          // agent is idle and ready for the next message
          else {
            emitSSE(store, turnId, {
              type: "result",
              data: {
                turnId,
                success: true,
                cost: capturedCostUsd ?? 0,
                turns: turn.turns,
                sdkSessionId: capturedClaudeSessionId,
                isTurnResult: true,
              },
            });
          }
          break;
        }

        case "system": {
          // Init or status message — capture model/session info
          break;
        }

        default:
          break;
      }
    }

    // If we didn't already transition to completed
    const currentTurn = store.getTurn(turnId);
    if (currentTurn?.status === "running") {
      store.completeTurn(turnId);
    }
  } catch (err: unknown) {
    if (turn.abortController.signal.aborted) {
      handleAbort(store, turnId);
      return;
    }

    const message =
      err instanceof Error ? err.message : "Unknown agent error";
    logger.error({ err, turnId }, "Agent runner error");
    store.failTurn(turnId, message);
    emitSSE(store, turnId, {
      type: "error",
      data: { message },
    });
  } finally {
    clearTimeout(timeoutHandle);

    // Flush any buffered tap messages
    const flushPromises: Promise<void>[] = [
      tapFileSink.flush().catch((err) => {
        logger.warn({ err }, "Failed to flush tap file sink");
      }),
    ];
    if (tapHttpSink) {
      flushPromises.push(
        tapHttpSink.flush().catch((err) => {
          logger.warn({ err }, "Failed to flush tap HTTP sink");
        }),
      );
    }
    await Promise.all(flushPromises);

    // Emit result and done
    const finalTurn = store.getTurn(turnId);
    emitSSE(store, turnId, {
      type: "result",
      data: {
        turnId,
        success: finalTurn?.status === "completed",
        cost: capturedCostUsd ?? 0,
        duration: finalTurn?.durationMs ?? 0,
        turns: finalTurn?.turns ?? 0,
        sdkSessionId: capturedClaudeSessionId,
      },
    });
    emitSSE(store, turnId, { type: "done", data: {} });
  }
}

// ---------------------------------------------------------------------------
// Stream event processor (reused from raw SDK streaming events)
// ---------------------------------------------------------------------------

export interface StreamState {
  currentBlockTypes: Map<number, string>;
  pendingToolInputs: Map<number, { id: string; name: string; inputJson: string }>;
}

export function processStreamEvent(
  store: TurnStore,
  turnId: string,
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
        emitSSE(store, turnId, {
          type: "tool_start",
          data: {
            toolName,
            toolId,
          },
        });
      } else if (block.type === "thinking") {
        emitSSE(store, turnId, {
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
        emitSSE(store, turnId, {
          type: "text_delta",
          data: { content: delta.text ?? "" },
        });
      } else if (delta.type === "thinking_delta") {
        emitSSE(store, turnId, {
          type: "thinking_delta",
          data: {
            assistantUuid,
            blockIndex: index,
            content: delta.thinking ?? "",
          },
        });
      } else if (delta.type === "signature_delta") {
        emitSSE(store, turnId, {
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
          emitSSE(store, turnId, {
            type: "tool_use",
            data: {
              toolName: pending.name,
              toolId: pending.id,
              input,
            },
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

export function emitFinalContentBlocks(
  store: TurnStore,
  turnId: string,
  message: {
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  },
  assistantUuid: string,
): void {
  for (const [blockIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      emitSSE(store, turnId, {
        type: "text",
        data: { content: block.text ?? "", uuid: assistantUuid },
      });
    } else if (block.type === "tool_use") {
      // Emit tool_use with full input from the authoritative assistant message.
      // This ensures the client always receives tool input even if the
      // streaming content_block_stop event was missed or had empty input.
      emitSSE(store, turnId, {
        type: "tool_use",
        data: {
          toolName: block.name ?? "",
          toolId: block.id ?? "",
          input: block.input ?? {},
        },
      });
    } else if (block.type === "thinking") {
      emitSSE(store, turnId, {
        type: "thinking_complete",
        data: {
          assistantUuid,
          blockIndex,
          content: block.thinking ?? "",
          signature: block.signature,
        },
      });
    } else if (block.type === "redacted_thinking") {
      emitSSE(store, turnId, {
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
  store: TurnStore,
  turnId: string,
  event: SSEEvent,
): void {
  store.emitSSE(turnId, event);
}

function handleAbort(store: TurnStore, turnId: string): void {
  const currentTurn = store.getTurn(turnId);
  if (currentTurn?.status === "running") {
    store.cancelTurn(turnId);
    emitSSE(store, turnId, {
      type: "error",
      data: { message: "Turn was cancelled" },
    });
  }
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
