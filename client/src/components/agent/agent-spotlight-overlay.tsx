import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";

interface HighlightState {
  elementId: string;
  tooltip: string | null;
  rect: DOMRect | null;
}

const PADDING = 8;
const BORDER_WIDTH = 3;
const RETRY_INTERVAL = 200;
const MAX_RETRIES = 10;

export function AgentSpotlightOverlay() {
  const [highlight, setHighlight] = useState<HighlightState | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    setHighlight(null);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const measureElement = useCallback((elementId: string): DOMRect | null => {
    const el = document.querySelector(`[data-tour="${elementId}"]`);
    if (!el) return null;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return el.getBoundingClientRect();
  }, []);

  // Listen for agent:highlight events
  useEffect(() => {
    function handleHighlight(e: Event) {
      const { elementId, tooltip } = (e as CustomEvent).detail as {
        elementId: string;
        tooltip: string | null;
        duration: number;
      };

      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

      const rect = measureElement(elementId);
      if (rect) {
        setHighlight({ elementId, tooltip, rect });
      } else {
        // Retry: element may not be rendered yet (e.g. after navigation)
        let retries = 0;
        const tryFind = () => {
          retries++;
          const r = measureElement(elementId);
          if (r) {
            setHighlight({ elementId, tooltip, rect: r });
          } else if (retries < MAX_RETRIES) {
            retryTimerRef.current = setTimeout(tryFind, RETRY_INTERVAL);
          }
        };
        retryTimerRef.current = setTimeout(tryFind, RETRY_INTERVAL);
      }
    }

    window.addEventListener("agent:highlight", handleHighlight);
    return () => {
      window.removeEventListener("agent:highlight", handleHighlight);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [measureElement]);

  // Update position on scroll/resize
  const activeElementId = highlight?.elementId ?? null;
  useEffect(() => {
    if (!activeElementId) return;

    function updateRect() {
      setHighlight((prev) => {
        if (!prev) return null;
        const r = document
          .querySelector(`[data-tour="${prev.elementId}"]`)
          ?.getBoundingClientRect() ?? null;
        if (!r) return prev;
        return { ...prev, rect: r };
      });
    }

    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [activeElementId]);

  // Click on the highlighted element dismisses the highlight
  useEffect(() => {
    if (!highlight?.elementId) return;
    const el = document.querySelector(
      `[data-tour="${highlight.elementId}"]`,
    );
    if (!el) return;

    const handleClick = () => dismiss();
    el.addEventListener("click", handleClick, { once: true });
    return () => el.removeEventListener("click", handleClick);
  }, [highlight?.elementId, dismiss]);

  if (!highlight?.rect) return null;

  const { rect, tooltip } = highlight;
  const x = rect.left - PADDING;
  const y = rect.top - PADDING;
  const w = rect.width + PADDING * 2;
  const h = rect.height + PADDING * 2;

  // Tooltip positioning: prefer below, flip above if near viewport bottom
  const tooltipBelow = y + h + 8 + 60 < window.innerHeight;
  const tooltipTop = tooltipBelow ? y + h + 8 : y - 8;

  return createPortal(
    <>
      {/* Rainbow border around the element — doesn't block clicks */}
      <div
        className="fixed z-[9999] spotlight-rainbow pointer-events-none rounded-md"
        style={{
          left: x,
          top: y,
          width: w,
          height: h,
          padding: BORDER_WIDTH,
        }}
      />

      {/* Tooltip with X button — right-aligned to the highlight */}
      {tooltip && (
        <div
          className="fixed z-[9999] pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-md bg-popover text-popover-foreground text-sm font-semibold shadow-lg border max-w-xs animate-in fade-in"
          style={{
            right: Math.max(window.innerWidth - (x + w), 8),
            top: tooltipTop,
            ...(tooltipBelow ? {} : { transform: "translateY(-100%)" }),
          }}
        >
          <span className="flex-1">{tooltip}</span>
          <button
            onClick={dismiss}
            className="shrink-0 rounded-sm p-0.5 hover:bg-accent text-muted-foreground"
            aria-label="Dismiss highlight"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}
