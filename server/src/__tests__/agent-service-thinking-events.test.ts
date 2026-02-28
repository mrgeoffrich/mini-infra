import type { Response } from "express";
import { AgentService } from "../services/agent-service";

function createTestHarness() {
  const writes: string[] = [];
  const res = {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  } as unknown as Response;

  const session = {
    subscribers: new Set<Response>([res]),
  } as any;

  const service = new AgentService("mk_test_key");
  const processSDKMessage = (service as any).processSDKMessage.bind(service) as (
    sessionArg: any,
    msg: any,
  ) => void;

  return { processSDKMessage, session, writes };
}

function parseLastEvent(writes: string[]) {
  const last = writes.at(-1);
  if (!last) throw new Error("No SSE writes captured");
  const payload = last.replace(/^data:\s*/, "").trim();
  return JSON.parse(payload) as { type: string; data: Record<string, unknown> };
}

describe("AgentService thinking event mapping", () => {
  it("maps thinking_delta stream events to thinking_delta SSE payload", () => {
    const { processSDKMessage, session, writes } = createTestHarness();

    processSDKMessage(session, {
      type: "stream_event",
      uuid: "assistant-uuid-1",
      session_id: "session-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Need to inspect deployments first.",
        },
      },
    });

    expect(parseLastEvent(writes)).toEqual({
      type: "thinking_delta",
      data: {
        assistantUuid: "assistant-uuid-1",
        blockIndex: 0,
        content: "Need to inspect deployments first.",
      },
    });
  });

  it("maps signature_delta stream events to thinking_signature SSE payload", () => {
    const { processSDKMessage, session, writes } = createTestHarness();

    processSDKMessage(session, {
      type: "stream_event",
      uuid: "assistant-uuid-2",
      session_id: "session-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "signature_delta",
          signature: "sig_123",
        },
      },
    });

    expect(parseLastEvent(writes)).toEqual({
      type: "thinking_signature",
      data: {
        assistantUuid: "assistant-uuid-2",
        blockIndex: 1,
        signature: "sig_123",
      },
    });
  });

  it("maps assistant thinking blocks to thinking_complete SSE payload", () => {
    const { processSDKMessage, session, writes } = createTestHarness();

    processSDKMessage(session, {
      type: "assistant",
      uuid: "assistant-uuid-3",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Confirming environment before making changes.",
            signature: "sig_abc",
          },
        ],
      },
    });

    expect(parseLastEvent(writes)).toEqual({
      type: "thinking_complete",
      data: {
        assistantUuid: "assistant-uuid-3",
        blockIndex: 0,
        content: "Confirming environment before making changes.",
        signature: "sig_abc",
      },
    });
  });

  it("maps assistant redacted_thinking blocks to thinking_redacted SSE payload", () => {
    const { processSDKMessage, session, writes } = createTestHarness();

    processSDKMessage(session, {
      type: "assistant",
      uuid: "assistant-uuid-4",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "redacted_thinking", data: "hidden" }],
      },
    });

    expect(parseLastEvent(writes)).toEqual({
      type: "thinking_redacted",
      data: {
        assistantUuid: "assistant-uuid-4",
        blockIndex: 0,
        content: "Thinking content is redacted.",
      },
    });
  });

  it("maps message_stop stream events to assistant_message_stop SSE payload", () => {
    const { processSDKMessage, session, writes } = createTestHarness();

    processSDKMessage(session, {
      type: "stream_event",
      uuid: "assistant-uuid-5",
      session_id: "session-1",
      parent_tool_use_id: null,
      event: { type: "message_stop" },
    });

    expect(parseLastEvent(writes)).toEqual({
      type: "assistant_message_stop",
      data: {
        assistantUuid: "assistant-uuid-5",
      },
    });
  });
});
