import Anthropic from "@anthropic-ai/sdk";
import { TaskStore } from "../task-store";
import { TokenUsage } from "../types";
import { buildSystemPrompt } from "./system-prompt";
import { TOOL_DEFINITIONS, executeTool, summarizeOutput } from "./tools";
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

// ---------------------------------------------------------------------------
// Cancellation registry
// ---------------------------------------------------------------------------

const activeAbortControllers = new Map<string, AbortController>();

export function cancelTask(taskId: string): boolean {
  const controller = activeAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(taskId);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

export async function runAgent(
  taskId: string,
  store: TaskStore,
): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) {
    logger.error({ taskId }, "Task not found when starting agent");
    return;
  }

  const client = new Anthropic();
  const systemPrompt = buildSystemPrompt();
  const abortController = new AbortController();
  activeAbortControllers.set(taskId, abortController);

  const timeoutHandle = setTimeout(() => {
    logger.warn({ taskId }, "Task timed out");
    abortController.abort();
  }, AGENT_TIMEOUT_MS);

  // Build initial message with optional context
  let userMessage = task.prompt;
  if (task.context && Object.keys(task.context).length > 0) {
    userMessage += `\n\nContext: ${JSON.stringify(task.context, null, 2)}`;
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const cumulativeUsage: TokenUsage = { input: 0, output: 0 };

  store.emitSSE(taskId, {
    type: "status",
    data: { status: "running", message: "Agent is analyzing your request..." },
  });

  let turns = 0;

  try {
    while (turns < AGENT_MAX_TURNS) {
      if (abortController.signal.aborted) {
        store.cancelTask(taskId);
        store.emitSSE(taskId, {
          type: "error",
          data: { status: "failed", error: "Task was cancelled" },
        });
        return;
      }

      const response = await client.messages.create(
        {
          model: AGENT_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages,
          tools: TOOL_DEFINITIONS,
        },
        {
          signal: abortController.signal,
        },
      );

      // Accumulate token usage
      cumulativeUsage.input += response.usage.input_tokens;
      cumulativeUsage.output += response.usage.output_tokens;
      store.updateTokenUsage(taskId, { ...cumulativeUsage });

      // Process content blocks
      const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          store.emitSSE(taskId, {
            type: "text",
            data: { content: block.text },
          });
        } else if (block.type === "tool_use") {
          toolUseBlocks.push(block);

          store.emitSSE(taskId, {
            type: "tool_call",
            data: {
              tool: block.name,
              input: block.input as Record<string, unknown>,
            },
          });

          store.addToolCall(
            taskId,
            block.name,
            block.input as Record<string, unknown>,
          );
        }
      }

      // If stop_reason is "end_turn", the agent is done
      if (response.stop_reason === "end_turn") {
        const finalText = extractFinalText(response);
        store.completeTask(taskId, finalText);
        store.emitSSE(taskId, {
          type: "complete",
          data: { status: "completed", result: finalText },
        });
        return;
      }

      // If stop_reason is "tool_use", execute tool calls
      if (response.stop_reason === "tool_use" && toolUseBlocks.length > 0) {
        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const toolBlock of toolUseBlocks) {
          if (abortController.signal.aborted) {
            store.cancelTask(taskId);
            store.emitSSE(taskId, {
              type: "error",
              data: { status: "failed", error: "Task was cancelled" },
            });
            return;
          }

          const result = await executeTool(
            toolBlock.name,
            toolBlock.input as Record<string, unknown>,
          );

          store.emitSSE(taskId, {
            type: "tool_result",
            data: {
              tool: toolBlock.name,
              summary: summarizeOutput(toolBlock.name, result),
            },
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        messages.push({ role: "user", content: toolResults });
        turns++;
        continue;
      }

      // Unexpected stop reason — treat as done
      const finalText = extractFinalText(response);
      store.completeTask(
        taskId,
        finalText || "Agent finished (no final response).",
      );
      store.emitSSE(taskId, {
        type: "complete",
        data: {
          status: "completed",
          result: finalText || "Agent finished.",
        },
      });
      return;
    }

    // Exceeded max turns
    store.failTask(
      taskId,
      `Agent exceeded maximum turns (${AGENT_MAX_TURNS})`,
    );
    store.emitSSE(taskId, {
      type: "error",
      data: {
        status: "failed",
        error: `Agent exceeded maximum turns (${AGENT_MAX_TURNS})`,
      },
    });
  } catch (err: unknown) {
    if (abortController.signal.aborted) {
      const currentTask = store.getTask(taskId);
      if (currentTask?.status === "running") {
        // Distinguish timeout from user cancellation
        const wasTimeout = !activeAbortControllers.has(taskId);
        if (wasTimeout) {
          store.timeoutTask(taskId);
          store.emitSSE(taskId, {
            type: "error",
            data: { status: "timeout", error: "Task execution timed out" },
          });
        } else {
          store.cancelTask(taskId);
          store.emitSSE(taskId, {
            type: "error",
            data: { status: "failed", error: "Task was cancelled" },
          });
        }
      }
      return;
    }

    // Genuine error
    const message =
      err instanceof Error ? err.message : "Unknown agent error";
    logger.error({ err, taskId }, "Agent runner error");
    store.failTask(taskId, message);
    store.emitSSE(taskId, {
      type: "error",
      data: { status: "failed", error: message },
    });
  } finally {
    clearTimeout(timeoutHandle);
    activeAbortControllers.delete(taskId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFinalText(response: Anthropic.Messages.Message): string {
  const textBlocks = response.content.filter(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n\n");
}
