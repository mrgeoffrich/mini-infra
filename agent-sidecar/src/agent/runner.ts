import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { SessionStore, AgentMessageQueue } from "../session-store";
import { TokenUsage, SSEEvent } from "../types";
import { buildSystemPrompt } from "./system-prompt";
import { TOOL_DEFINITIONS, executeTool, summarizeOutput } from "./tools";
import {
  UI_TOOL_DEFINITIONS,
  UI_TOOL_NAMES,
  executeUITool,
} from "./ui-tools";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-4-6";
const AGENT_MAX_TURNS = parseInt(process.env.AGENT_MAX_TURNS ?? "50", 10);
const AGENT_TIMEOUT_MS = parseInt(
  process.env.AGENT_TIMEOUT_MS ?? "300000",
  10,
);
const MAX_TOKENS = 16384;

// Extended thinking config
const THINKING_ENABLED = process.env.AGENT_THINKING === "enabled";
const THINKING_BUDGET = parseInt(
  process.env.AGENT_THINKING_BUDGET ?? "10000",
  10,
);

// ---------------------------------------------------------------------------
// Agent runner — streaming + multi-turn
// ---------------------------------------------------------------------------

export async function runSession(
  sessionId: string,
  store: SessionStore,
  initialMessage: string,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session) {
    logger.error({ sessionId }, "Session not found when starting agent");
    return;
  }

  const client = new Anthropic();
  const systemPrompt = buildSystemPrompt();
  const allTools = [...TOOL_DEFINITIONS, ...UI_TOOL_DEFINITIONS];

  const timeoutHandle = setTimeout(() => {
    logger.warn({ sessionId }, "Session timed out");
    session.abortController.abort();
  }, AGENT_TIMEOUT_MS);

  const cumulativeUsage: TokenUsage = { input: 0, output: 0 };

  // Emit init event
  emitSSE(store, sessionId, {
    type: "init",
    data: { sessionId, model: AGENT_MODEL },
  });

  // Add the initial user message
  session.messages.push({
    role: "user",
    content: initialMessage,
  });

  const queue = session.queue;
  let waitingForUser = false;

  try {
    let turns = 0;

    while (turns < AGENT_MAX_TURNS) {
      if (session.abortController.signal.aborted) {
        handleAbort(store, sessionId, session);
        return;
      }

      // Run one streaming API call
      const assistantUuid = uuidv4();
      session.currentTurnUuid = assistantUuid;
      session.currentBlockTypes.clear();
      session.pendingToolInputs.clear();

      // Build request params
      const params: Anthropic.Messages.MessageCreateParamsStreaming = {
        model: AGENT_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: session.messages,
        tools: allTools,
        stream: true,
      };

      // Add thinking support if enabled
      if (THINKING_ENABLED) {
        (params as unknown as Record<string, unknown>).thinking = {
          type: "enabled",
          budget_tokens: THINKING_BUDGET,
        };
      }

      const stream = client.messages.stream(params, {
        signal: session.abortController.signal,
      });

      // Process streaming events
      for await (const event of stream) {
        if (session.abortController.signal.aborted) {
          handleAbort(store, sessionId, session);
          return;
        }

        processStreamEvent(store, sessionId, session, event, assistantUuid);
      }

      // Get the final message
      const message = await stream.finalMessage();

      // Accumulate token usage
      cumulativeUsage.input += message.usage.input_tokens;
      cumulativeUsage.output += message.usage.output_tokens;
      store.updateTokenUsage(sessionId, { ...cumulativeUsage });

      // Emit complete content blocks from the final message
      emitFinalContentBlocks(store, sessionId, message, assistantUuid);

      // Emit assistant_message_stop
      emitSSE(store, sessionId, {
        type: "assistant_message_stop",
        data: { assistantUuid },
      });

      // Add assistant message to conversation
      session.messages.push({
        role: "assistant",
        content: message.content,
      });

      // Handle stop reason
      if (message.stop_reason === "tool_use") {
        // Execute tools and continue
        const toolBlocks = message.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const toolBlock of toolBlocks) {
          if (session.abortController.signal.aborted) {
            handleAbort(store, sessionId, session);
            return;
          }

          const input = toolBlock.input as Record<string, unknown>;
          let result: { content: string; isError: boolean };

          if (UI_TOOL_NAMES.has(toolBlock.name)) {
            // UI tool — execute and emit SSE event
            const uiResult = executeUITool(
              toolBlock.name,
              input,
              session.currentPath,
            );
            result = { content: uiResult.content, isError: uiResult.isError };
            if (uiResult.sseEvent) {
              emitSSE(store, sessionId, uiResult.sseEvent);
            }
          } else {
            // Infrastructure tool
            result = await executeTool(toolBlock.name, input);
          }

          // Emit tool_result
          emitSSE(store, sessionId, {
            type: "tool_result",
            data: {
              toolId: toolBlock.id,
              output: summarizeOutput(toolBlock.name, result),
            },
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // Add tool results to conversation
        session.messages.push({
          role: "user",
          content: toolResults,
        });

        turns++;
        store.incrementTurns(sessionId);
        continue;
      }

      if (message.stop_reason === "end_turn") {
        // Agent is done with this turn — wait for follow-up or close
        waitingForUser = true;

        // Wait for the next user message from the queue
        const nextMessage = await waitForNextMessage(queue, session);
        if (nextMessage === null) {
          // Queue closed or aborted — session is done
          break;
        }

        // Add user message to conversation
        session.messages.push({
          role: "user",
          content: nextMessage,
        });

        waitingForUser = false;
        turns++;
        store.incrementTurns(sessionId);
        continue;
      }

      // Unexpected stop reason — done
      break;
    }

    // Session complete (either max turns or normal completion)
    if (turns >= AGENT_MAX_TURNS) {
      store.failSession(
        sessionId,
        `Agent exceeded maximum turns (${AGENT_MAX_TURNS})`,
      );
      emitSSE(store, sessionId, {
        type: "error",
        data: {
          message: `Agent exceeded maximum turns (${AGENT_MAX_TURNS})`,
        },
      });
    } else {
      store.completeSession(sessionId);
    }
  } catch (err: unknown) {
    if (session.abortController.signal.aborted) {
      handleAbort(store, sessionId, session);
      return;
    }

    // Genuine error
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
    session.currentTurnUuid = null;

    // Emit result and done
    const finalSession = store.getSession(sessionId);
    emitSSE(store, sessionId, {
      type: "result",
      data: {
        success: finalSession?.status === "completed",
        cost: 0,
        duration: finalSession?.durationMs ?? 0,
        turns: finalSession?.turns ?? 0,
      },
    });
    emitSSE(store, sessionId, { type: "done", data: {} });
  }
}

// ---------------------------------------------------------------------------
// Stream event processor
// ---------------------------------------------------------------------------

function processStreamEvent(
  store: SessionStore,
  sessionId: string,
  session: ReturnType<SessionStore["getSession"]> & object,
  event: Anthropic.Messages.RawMessageStreamEvent,
  assistantUuid: string,
): void {
  switch (event.type) {
    case "message_start": {
      // Capture the message ID for consistency
      if (event.message?.id) {
        (session as { currentTurnUuid: string | null }).currentTurnUuid =
          event.message.id;
      }
      break;
    }

    case "content_block_start": {
      const block = event.content_block;
      const index = event.index;
      (session as { currentBlockTypes: Map<number, string> }).currentBlockTypes.set(
        index,
        block.type,
      );

      if (block.type === "tool_use") {
        const toolBlock = block as Anthropic.Messages.ToolUseBlock;
        // Start accumulating input JSON
        (session as { pendingToolInputs: Map<number, { id: string; name: string; inputJson: string }> }).pendingToolInputs.set(
          index,
          { id: toolBlock.id, name: toolBlock.name, inputJson: "" },
        );
        emitSSE(store, sessionId, {
          type: "tool_start",
          data: { toolName: toolBlock.name, toolId: toolBlock.id },
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
      const delta = event.delta;
      const index = event.index;

      if (delta.type === "text_delta") {
        emitSSE(store, sessionId, {
          type: "text_delta",
          data: { content: delta.text },
        });
      } else if (delta.type === "thinking_delta") {
        emitSSE(store, sessionId, {
          type: "thinking_delta",
          data: {
            assistantUuid,
            blockIndex: index,
            content: (delta as { thinking: string }).thinking,
          },
        });
      } else if (delta.type === "signature_delta") {
        emitSSE(store, sessionId, {
          type: "thinking_signature",
          data: {
            assistantUuid,
            blockIndex: index,
            signature: (delta as { signature: string }).signature,
          },
        });
      } else if (delta.type === "input_json_delta") {
        const pending = (session as { pendingToolInputs: Map<number, { id: string; name: string; inputJson: string }> }).pendingToolInputs.get(index);
        if (pending) {
          pending.inputJson += (delta as { partial_json: string }).partial_json;
        }
      }
      break;
    }

    case "content_block_stop": {
      const index = event.index;
      const blockType = (session as { currentBlockTypes: Map<number, string> }).currentBlockTypes.get(index);

      // Emit tool_use with accumulated input when tool_use block stops
      if (blockType === "tool_use") {
        const pending = (session as { pendingToolInputs: Map<number, { id: string; name: string; inputJson: string }> }).pendingToolInputs.get(index);
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
        }
      }
      break;
    }

    // message_delta and message_stop are handled after the stream loop
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Emit final content blocks from the complete message
// ---------------------------------------------------------------------------

function emitFinalContentBlocks(
  store: SessionStore,
  sessionId: string,
  message: Anthropic.Messages.Message,
  assistantUuid: string,
): void {
  for (const [blockIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      emitSSE(store, sessionId, {
        type: "text",
        data: { content: block.text, uuid: assistantUuid },
      });
    } else if (block.type === "thinking") {
      const thinkingBlock = block as {
        type: "thinking";
        thinking: string;
        signature?: string;
      };
      emitSSE(store, sessionId, {
        type: "thinking_complete",
        data: {
          assistantUuid,
          blockIndex,
          content: thinkingBlock.thinking,
          signature: thinkingBlock.signature,
        },
      });
    } else if (
      "type" in block &&
      (block as { type: string }).type === "redacted_thinking"
    ) {
      emitSSE(store, sessionId, {
        type: "thinking_redacted",
        data: {
          assistantUuid,
          blockIndex,
          content: "Thinking content is redacted.",
        },
      });
    }
    // tool_use blocks are already emitted during streaming
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

function handleAbort(
  store: SessionStore,
  sessionId: string,
  session: ReturnType<SessionStore["getSession"]> & object,
): void {
  const currentSession = store.getSession(sessionId);
  if (currentSession?.status === "running") {
    store.cancelSession(sessionId);
  }
  emitSSE(store, sessionId, {
    type: "error",
    data: { message: "Session was cancelled" },
  });
}

async function waitForNextMessage(
  queue: AgentMessageQueue,
  session: { abortController: AbortController },
): Promise<string | null> {
  // Race the queue against the abort signal
  return new Promise<string | null>((resolve) => {
    if (session.abortController.signal.aborted) {
      resolve(null);
      return;
    }

    const onAbort = () => {
      resolve(null);
    };
    session.abortController.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    const iterator = queue[Symbol.asyncIterator]();
    iterator.next().then(
      (result) => {
        session.abortController.signal.removeEventListener("abort", onAbort);
        if (result.done) {
          resolve(null);
        } else {
          resolve(result.value);
        }
      },
      () => {
        session.abortController.signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}
