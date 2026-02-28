import { useState, useCallback, useRef, useEffect } from "react";
import {
  ChatMessage,
  SessionStatus,
  AgentSession,
} from "../lib/agent-chat-types";

interface UseAgentSessionResult {
  messages: ChatMessage[];
  streamingText: string;
  sessionStatus: SessionStatus;
  session: AgentSession | null;
  model: string | null;
  sendMessage: (message: string) => Promise<void>;
  startNewChat: () => void;
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
          const parsed = JSON.parse(event.data);
          const { type, data } = parsed;

          switch (type) {
            case "connected":
              break;

            case "init":
              if (data?.model) {
                setModel(data.model);
              }
              setSessionStatus("streaming");
              break;

            case "text_delta":
              streamingTextRef.current += data?.content ?? "";
              setStreamingText(streamingTextRef.current);
              setSessionStatus("streaming");
              break;

            case "text": {
              const textContent = data?.content ?? "";
              streamingTextRef.current = "";
              setStreamingText("");
              setMessages((prev) => [
                ...prev,
                {
                  id: data?.uuid ?? crypto.randomUUID(),
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
                  id: data?.toolId ?? crypto.randomUUID(),
                  role: "tool_use",
                  toolId: data?.toolId ?? "",
                  toolName: data?.toolName ?? "",
                  timestamp: Date.now(),
                },
              ]);
              break;

            case "tool_use":
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.role === "tool_use" && msg.toolId === data?.toolId
                    ? { ...msg, input: data?.input }
                    : msg,
                ),
              );
              break;

            case "tool_result":
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.role === "tool_use" && msg.toolId === data?.toolId
                    ? { ...msg, output: data?.output }
                    : msg,
                ),
              );
              setSessionStatus("streaming");
              break;

            case "error":
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "error",
                  content: data?.message ?? "An error occurred",
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
                  success: data?.success ?? false,
                  cost: data?.cost,
                  duration: data?.duration,
                  turns: data?.turns,
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
    [closeEventSource],
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
        setSessionStatus("error");
      }
    },
    [session, connectSSE],
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
    setSessionStatus("idle");
    setSession(null);
    setModel(null);
  }, [session, closeEventSource]);

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
