import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processStreamEvent,
  emitFinalContentBlocks,
  type StreamState,
} from "./runner";
import type { TurnStore } from "../turn-store";
import type { SSEEvent } from "../types";

// Minimal mock of TurnStore — we only need emitSSE
function createMockStore(): TurnStore & { events: SSEEvent[] } {
  const events: SSEEvent[] = [];
  return {
    events,
    emitSSE: vi.fn((_turnId: string, event: SSEEvent) => {
      events.push(event);
    }),
  } as unknown as TurnStore & { events: SSEEvent[] };
}

function createStreamState(): StreamState {
  return {
    currentBlockTypes: new Map(),
    pendingToolInputs: new Map(),
  };
}

describe("processStreamEvent", () => {
  let store: ReturnType<typeof createMockStore>;
  let state: StreamState;
  const turnId = "turn_abc123";
  const assistantUuid = "uuid-1234";

  beforeEach(() => {
    store = createMockStore();
    state = createStreamState();
  });

  it("emits tool_start on content_block_start for tool_use", () => {
    processStreamEvent(store, turnId, state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "Skill" },
    }, assistantUuid);

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toEqual({
      type: "tool_start",
      data: { toolName: "Skill", toolId: "tool-1" },
    });
  });

  it("emits tool_use with parsed input on content_block_stop", () => {
    // Start a tool_use block
    processStreamEvent(store, turnId, state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "Skill" },
    }, assistantUuid);

    // Accumulate input JSON via deltas
    processStreamEvent(store, turnId, state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"skill":' },
    }, assistantUuid);

    processStreamEvent(store, turnId, state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"setting-up-services"}' },
    }, assistantUuid);

    // Stop the block — should emit tool_use with full input
    processStreamEvent(store, turnId, state, {
      type: "content_block_stop",
      index: 0,
    }, assistantUuid);

    const toolUseEvent = store.events.find((e) => e.type === "tool_use");
    expect(toolUseEvent).toBeDefined();
    expect(toolUseEvent!.data).toEqual({
      toolName: "Skill",
      toolId: "tool-1",
      input: { skill: "setting-up-services" },
    });
  });

  it("emits tool_use with empty input when no deltas received", () => {
    processStreamEvent(store, turnId, state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "Skill" },
    }, assistantUuid);

    processStreamEvent(store, turnId, state, {
      type: "content_block_stop",
      index: 0,
    }, assistantUuid);

    const toolUseEvent = store.events.find((e) => e.type === "tool_use");
    expect(toolUseEvent).toBeDefined();
    expect(toolUseEvent!.data).toEqual({
      toolName: "Skill",
      toolId: "tool-1",
      input: {},
    });
  });
});

describe("emitFinalContentBlocks", () => {
  let store: ReturnType<typeof createMockStore>;
  const turnId = "turn_abc123";
  const assistantUuid = "uuid-1234";

  beforeEach(() => {
    store = createMockStore();
  });

  it("emits tool_use event for Skill tool_use blocks with full input", () => {
    emitFinalContentBlocks(store, turnId, {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Skill",
          input: { skill: "setting-up-services" },
        },
      ],
    }, assistantUuid);

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toEqual({
      type: "tool_use",
      data: {
        toolName: "Skill",
        toolId: "tool-1",
        input: { skill: "setting-up-services" },
      },
    });
  });

  it("emits tool_use for any tool_use block (Bash, Read, etc.)", () => {
    emitFinalContentBlocks(store, turnId, {
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: { command: "ls -la" },
        },
      ],
    }, assistantUuid);

    expect(store.events).toHaveLength(1);
    expect(store.events[0].data).toEqual({
      toolName: "Bash",
      toolId: "tool-2",
      input: { command: "ls -la" },
    });
  });

  it("emits text events alongside tool_use events in mixed content", () => {
    emitFinalContentBlocks(store, turnId, {
      content: [
        { type: "text", text: "Loading skill..." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "Skill",
          input: { skill: "setting-up-services" },
        },
      ],
    }, assistantUuid);

    expect(store.events).toHaveLength(2);
    expect(store.events[0].type).toBe("text");
    expect(store.events[1].type).toBe("tool_use");
    expect(store.events[1].data).toEqual({
      toolName: "Skill",
      toolId: "tool-1",
      input: { skill: "setting-up-services" },
    });
  });

  it("handles tool_use blocks with missing fields gracefully", () => {
    emitFinalContentBlocks(store, turnId, {
      content: [
        { type: "tool_use" },
      ],
    }, assistantUuid);

    expect(store.events).toHaveLength(1);
    expect(store.events[0].data).toEqual({
      toolName: "",
      toolId: "",
      input: {},
    });
  });

  it("still emits text and thinking blocks correctly", () => {
    emitFinalContentBlocks(store, turnId, {
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Hmm...", signature: "sig-1" },
        { type: "redacted_thinking" },
      ],
    }, assistantUuid);

    expect(store.events).toHaveLength(3);
    expect(store.events[0].type).toBe("text");
    expect(store.events[1].type).toBe("thinking_complete");
    expect(store.events[2].type).toBe("thinking_redacted");
  });
});
