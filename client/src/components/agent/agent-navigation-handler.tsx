import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";
import { useAgentChat } from "@/hooks/use-agent-chat";

interface PendingNavigation {
  path: string;
  countdown: number;
}

const COUNTDOWN_START = 3;

/**
 * Listens for agent:navigate CustomEvents and shows a countdown panel
 * before performing client-side navigation. Must be mounted inside
 * a Router context and AgentChatProvider.
 */
export function AgentNavigationHandler() {
  const navigate = useNavigate();
  const { isOpen: chatOpen, isHistoryOpen } = useAgentChat();
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cancel = useCallback(() => {
    setPending(null);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Listen for agent:navigate events
  useEffect(() => {
    function handleNavigate(e: Event) {
      const { path } = (e as CustomEvent).detail as { path: string };
      // Clear any existing countdown
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setPending({ path, countdown: COUNTDOWN_START });
    }

    window.addEventListener("agent:navigate", handleNavigate);
    return () => {
      window.removeEventListener("agent:navigate", handleNavigate);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Countdown interval
  useEffect(() => {
    if (!pending) return;

    intervalRef.current = setInterval(() => {
      setPending((prev) => {
        if (!prev) return null;
        if (prev.countdown <= 1) {
          return { ...prev, countdown: 0 };
        }
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [pending?.path]);

  // Navigate when countdown hits 0
  useEffect(() => {
    if (pending?.countdown === 0) {
      navigate(pending.path);
      setPending(null);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [pending?.countdown, pending?.path, navigate]);

  // Escape key to cancel
  useEffect(() => {
    if (!pending) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [!!pending, cancel]);

  if (!pending) return null;

  // Position just to the left of the agent chat panel
  const rightOffset = chatOpen ? (isHistoryOpen ? 716 : 436) : 16;

  return createPortal(
    <div
      className="fixed z-[9998] flex flex-col gap-2 rounded-lg border bg-card text-card-foreground shadow-lg p-4 w-72 animate-in slide-in-from-right-5 fade-in"
      style={{
        top: 72,
        right: rightOffset,
        transition: "right 300ms ease-in-out",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Navigating...</span>
        <button
          onClick={cancel}
          className="rounded-sm p-0.5 hover:bg-accent text-muted-foreground"
          aria-label="Cancel navigation"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground truncate">
        Going to{" "}
        <code className="font-mono text-foreground">{pending.path}</code>
      </p>
      <div className="flex items-center justify-between">
        <span className="text-2xl font-bold tabular-nums">
          {pending.countdown}
        </span>
        <span className="text-xs text-muted-foreground">
          Press{" "}
          <kbd className="px-1 py-0.5 rounded border text-xs">Esc</kbd> to
          cancel
        </span>
      </div>
      {/* Progress bar */}
      <div className="h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-1000 ease-linear"
          style={{ width: `${(pending.countdown / COUNTDOWN_START) * 100}%` }}
        />
      </div>
    </div>,
    document.body,
  );
}
