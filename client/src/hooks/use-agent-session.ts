import { useState, useCallback, useRef, useEffect } from "react";
import {
  ChatMessage,
  ChatMessageThinking,
  SessionStatus,
  AgentSession,
} from "../lib/agent-chat-types";

const REDACTED_THINKING_PLACEHOLDER = "Thinking content is redacted.";

interface ThinkingIdentity {
  assistantUuid: string;
  blockIndex: number;
}

interface AgentSseEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface UseAgentSessionResult {
  messages: ChatMessage[];
  streamingText: string;
  sessionStatus: SessionStatus;
  session: AgentSession | null;
  model: string | null;
  sendMessage: (message: string) => Promise<void>;
  startNewChat: () => void;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseAgentSseEvent(raw: string): AgentSseEvent | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const maybeEvent = parsed as { type?: unknown; data?: unknown };
  if (typeof maybeEvent.type !== "string") {
    return null;
  }

  return {
    type: maybeEvent.type,
    data:
      maybeEvent.data && typeof maybeEvent.data === "object"
        ? (maybeEvent.data as Record<string, unknown>)
        : undefined,
  };
}

function buildThinkingKey({ assistantUuid, blockIndex }: ThinkingIdentity): string {
  return `${assistantUuid}:${blockIndex}`;
}

function parseThinkingIdentity(
  data?: Record<string, unknown>,
): ThinkingIdentity | null {
  const assistantUuid = asString(data?.assistantUuid);
  const blockIndex = asNumber(data?.blockIndex);
  if (!assistantUuid || blockIndex === undefined) {
    return null;
  }

  return { assistantUuid, blockIndex };
}

export function useAgentSession(currentPath?: string): UseAgentSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [session, setSession] = useState<AgentSession | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptedRef = useRef(false);
  const streamingTextRef = useRef("");
  const thinkingMessageKeyToIdRef = useRef<Map<string, string>>(new Map());

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearThinkingIndex = useCallback(() => {
    thinkingMessageKeyToIdRef.current.clear();
  }, []);

  const markAllThinkingComplete = useCallback(() => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.role === "thinking" && msg.status === "streaming"
          ? { ...msg, status: "complete" }
          : msg,
      ),
    );
  }, []);

  const markAssistantThinkingComplete = useCallback((assistantUuid: string) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.role === "thinking" &&
        msg.assistantUuid === assistantUuid &&
        msg.status === "streaming"
          ? { ...msg, status: "complete" }
          : msg,
      ),
    );

    const prefix = `${assistantUuid}:`;
    for (const key of thinkingMessageKeyToIdRef.current.keys()) {
      if (key.startsWith(prefix)) {
        thinkingMessageKeyToIdRef.current.delete(key);
      }
    }
  }, []);

  const upsertThinkingMessage = useCallback(
    (
      identity: ThinkingIdentity,
      updater: (
        existing: ChatMessageThinking | null,
        messageId: string,
      ) => ChatMessageThinking,
    ) => {
      const key = buildThinkingKey(identity);

      setMessages((prev) => {
        const mappedId = thinkingMessageKeyToIdRef.current.get(key);
        const existingIndex = prev.findIndex((msg) => {
          if (msg.role !== "thinking") return false;
          if (mappedId) return msg.id === mappedId;
          // Exact match: same turn UUID and block index.
          if (
            msg.assistantUuid === identity.assistantUuid &&
            msg.blockIndex === identity.blockIndex
          ) return true;
          // Fallback: if the turn UUID differs (e.g. SDK assigns per-event
          // UUIDs) match any currently-streaming block at this index.  A
          // streaming block can only belong to the current turn so there is
          // no risk of matching a completed block from an earlier turn.
          return msg.status === "streaming" && msg.blockIndex === identity.blockIndex;
        });

        const existingMessage =
          existingIndex >= 0 && prev[existingIndex].role === "thinking"
            ? (prev[existingIndex] as ChatMessageThinking)
            : null;

        const messageId = existingMessage?.id ?? mappedId ?? crypto.randomUUID();
        const nextMessage = updater(existingMessage, messageId);
        thinkingMessageKeyToIdRef.current.set(key, nextMessage.id);

        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = nextMessage;
          return next;
        }

        return [...prev, nextMessage];
      });
    },
    [],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeEventSource();
    };
  }, [closeEventSource]);

  // Notify backend when the user's route changes during an active session
  useEffect(() => {
    if (!session || !currentPath) return;
    fetch(`/api/agent/sessions/${session.sessionId}/context`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPath }),
    }).catch(() => {
      // Non-critical — ignore failures
    });
  }, [session, currentPath]);

  const connectSSE = useCallback(
    (sessionId: string, isRetry = false) => {
      closeEventSource();

      // Only reset the reconnect guard on a fresh connection, not on retries
      if (!isRetry) {
        reconnectAttemptedRef.current = false;
      }

      const url = `/api/agent/sessions/${sessionId}/stream`;
      const eventSource = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setSessionStatus("streaming");
      };

      eventSource.onmessage = (event) => {
        try {
          const parsed = parseAgentSseEvent(event.data);
          if (!parsed) return;
          const { type, data } = parsed;

          switch (type) {
            case "connected":
              break;

            case "init":
              {
                const modelName = asString(data?.model);
                if (modelName) {
                  setModel(modelName);
                }
              }
              setSessionStatus("streaming");
              break;

            case "text_delta":
              streamingTextRef.current += asString(data?.content) ?? "";
              setStreamingText(streamingTextRef.current);
              setSessionStatus("streaming");
              break;

            case "text": {
              const textContent = asString(data?.content) ?? "";
              streamingTextRef.current = "";
              setStreamingText("");
              setMessages((prev) => [
                ...prev,
                {
                  id: asString(data?.uuid) ?? crypto.randomUUID(),
                  role: "assistant",
                  content: textContent,
                  timestamp: Date.now(),
                },
              ]);
              break;
            }

            case "tool_start":
              setSessionStatus("waiting");
              setMessages((prev) => [
                ...prev,
                {
                  id: asString(data?.toolId) ?? crypto.randomUUID(),
                  role: "tool_use",
                  toolId: asString(data?.toolId) ?? "",
                  toolName: asString(data?.toolName) ?? "",
                  timestamp: Date.now(),
                },
              ]);
              break;

            case "tool_use":
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.role === "tool_use" &&
                  msg.toolId === (asString(data?.toolId) ?? "")
                    ? {
                        ...msg,
                        input: (data?.input as Record<string, unknown>) ?? undefined,
                      }
                    : msg,
                ),
              );
              break;

            case "tool_result":
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.role === "tool_use" &&
                  msg.toolId === (asString(data?.toolId) ?? "")
                    ? { ...msg, output: asString(data?.output) ?? "" }
                    : msg,
                ),
              );
              setSessionStatus("streaming");
              break;

            case "thinking_start": {
              const identity = parseThinkingIdentity(data);
              if (!identity) break;

              upsertThinkingMessage(identity, (existing, messageId) => ({
                id: messageId,
                role: "thinking",
                assistantUuid: identity.assistantUuid,
                blockIndex: identity.blockIndex,
                content: existing?.content ?? "",
                signature: existing?.signature,
                status: "streaming",
                redacted: existing?.redacted,
                timestamp: existing?.timestamp ?? Date.now(),
              }));
              setSessionStatus("streaming");
              break;
            }

            case "thinking_delta": {
              const identity = parseThinkingIdentity(data);
              if (!identity) break;

              const chunk = asString(data?.content) ?? "";
              upsertThinkingMessage(identity, (existing, messageId) => ({
                id: messageId,
                role: "thinking",
                assistantUuid: identity.assistantUuid,
                blockIndex: identity.blockIndex,
                content: `${existing?.content ?? ""}${chunk}`,
                signature: existing?.signature,
                status: "streaming",
                redacted: false,
                timestamp: existing?.timestamp ?? Date.now(),
              }));
              setSessionStatus("streaming");
              break;
            }

            case "thinking_signature": {
              const identity = parseThinkingIdentity(data);
              if (!identity) break;

              const signature = asString(data?.signature);
              if (!signature) break;

              upsertThinkingMessage(identity, (existing, messageId) => ({
                id: messageId,
                role: "thinking",
                assistantUuid: identity.assistantUuid,
                blockIndex: identity.blockIndex,
                content: existing?.content ?? "",
                signature,
                status: existing?.status ?? "streaming",
                redacted: existing?.redacted,
                timestamp: existing?.timestamp ?? Date.now(),
              }));
              break;
            }

            case "thinking_complete": {
              const identity = parseThinkingIdentity(data);
              if (!identity) break;

              upsertThinkingMessage(identity, (existing, messageId) => ({
                id: messageId,
                role: "thinking",
                assistantUuid: identity.assistantUuid,
                blockIndex: identity.blockIndex,
                content: asString(data?.content) ?? existing?.content ?? "",
                signature: asString(data?.signature) ?? existing?.signature,
                status: "complete",
                redacted: false,
                timestamp: existing?.timestamp ?? Date.now(),
              }));
              break;
            }

            case "thinking_redacted": {
              const identity = parseThinkingIdentity(data);
              if (!identity) break;

              upsertThinkingMessage(identity, (existing, messageId) => ({
                id: messageId,
                role: "thinking",
                assistantUuid: identity.assistantUuid,
                blockIndex: identity.blockIndex,
                content:
                  asString(data?.content) ??
                  existing?.content ??
                  REDACTED_THINKING_PLACEHOLDER,
                signature: existing?.signature,
                status: "complete",
                redacted: true,
                timestamp: existing?.timestamp ?? Date.now(),
              }));
              break;
            }

            case "assistant_message_stop": {
              const assistantUuid = asString(data?.assistantUuid);
              if (assistantUuid) {
                markAssistantThinkingComplete(assistantUuid);
              }
              break;
            }

            case "error":
              markAllThinkingComplete();
              clearThinkingIndex();
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "error",
                  content: asString(data?.message) ?? "An error occurred",
                  timestamp: Date.now(),
                },
              ]);
              setSessionStatus("error");
              break;

            case "result":
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "result",
                  success: asBoolean(data?.success) ?? false,
                  cost: asNumber(data?.cost),
                  duration: asNumber(data?.duration),
                  turns: asNumber(data?.turns),
                  timestamp: Date.now(),
                },
              ]);
              setSessionStatus("done");
              break;

            case "done": {
              // Flush any remaining streaming text as an assistant message
              const remaining = streamingTextRef.current;
              streamingTextRef.current = "";
              setStreamingText("");
              if (remaining.trim()) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: remaining,
                    timestamp: Date.now(),
                  },
                ]);
              }
              markAllThinkingComplete();
              clearThinkingIndex();
              setSessionStatus("done");
              break;
            }

            case "ui_highlight":
              window.dispatchEvent(
                new CustomEvent("agent:highlight", { detail: data }),
              );
              break;

            case "ui_navigate":
              window.dispatchEvent(
                new CustomEvent("agent:navigate", { detail: data }),
              );
              break;

            case "closed":
              closeEventSource();
              markAllThinkingComplete();
              clearThinkingIndex();
              setSessionStatus("idle");
              break;
          }
        } catch (err) {
          console.error("Failed to parse SSE event:", err);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();

        // Attempt one reconnect after 3s
        if (!reconnectAttemptedRef.current) {
          reconnectAttemptedRef.current = true;
          setSessionStatus("connecting");
          reconnectTimeoutRef.current = setTimeout(() => {
            connectSSE(sessionId, true);
          }, 3000);
        } else {
          markAllThinkingComplete();
          clearThinkingIndex();
          setSessionStatus("error");
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "error",
              content: "Connection lost. Please start a new chat.",
              timestamp: Date.now(),
            },
          ]);
        }
      };
    },
    [
      closeEventSource,
      clearThinkingIndex,
      markAllThinkingComplete,
      markAssistantThinkingComplete,
      upsertThinkingMessage,
    ],
  );

  const sendMessage = useCallback(
    async (message: string) => {
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      streamingTextRef.current = "";
      setStreamingText("");
      setSessionStatus("connecting");

      try {
        if (!session) {
          // Create new session
          const response = await fetch("/api/agent/sessions", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, currentPath }),
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            throw new Error(`Failed to create session: ${errorText}`);
          }

          const data = await response.json();
          const newSession: AgentSession = { sessionId: data.sessionId };
          setSession(newSession);
          connectSSE(newSession.sessionId);
        } else {
          // Send follow-up message
          const response = await fetch(
            `/api/agent/sessions/${session.sessionId}/messages`,
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message }),
            },
          );

          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => "Unknown error");
            throw new Error(`Failed to send message: ${errorText}`);
          }

          setSessionStatus("streaming");
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to send message";
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: errorMessage,
            timestamp: Date.now(),
          },
        ]);
        markAllThinkingComplete();
        clearThinkingIndex();
        setSessionStatus("error");
      }
    },
    [session, connectSSE, markAllThinkingComplete, clearThinkingIndex],
  );

  const startNewChat = useCallback(() => {
    closeEventSource();

    // Delete the session in the background
    if (session) {
      fetch(`/api/agent/sessions/${session.sessionId}`, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => {
        // Ignore errors on cleanup
      });
    }

    setMessages([]);
    streamingTextRef.current = "";
    setStreamingText("");
    clearThinkingIndex();
    setSessionStatus("idle");
    setSession(null);
    setModel(null);
  }, [session, closeEventSource, clearThinkingIndex]);

  return {
    messages,
    streamingText,
    sessionStatus,
    session,
    model,
    sendMessage,
    startNewChat,
  };
}
