import { useEffect, useId, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface HighlightState {
  elementId: string;
  tooltip: string | null;
  duration: number;
  rect: DOMRect | null;
}

const PADDING = 8;
const RETRY_INTERVAL = 200;
const MAX_RETRIES = 10;

export function AgentSpotlightOverlay() {
  const maskId = `spotlight-mask-${useId().replace(/:/g, "")}`;
  const [highlight, setHighlight] = useState<HighlightState | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    setHighlight(null);
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
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

  useEffect(() => {
    function handleHighlight(e: Event) {
      const { elementId, tooltip, duration } = (e as CustomEvent).detail as {
        elementId: string;
        tooltip: string | null;
        duration: number;
      };

      // Clear any existing timers
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

      const rect = measureElement(elementId);
      if (rect) {
        setHighlight({ elementId, tooltip, duration, rect });
        dismissTimerRef.current = setTimeout(dismiss, duration);
      } else {
        // Retry: element may not be rendered yet (e.g. after navigation)
        let retries = 0;
        const tryFind = () => {
          retries++;
          const r = measureElement(elementId);
          if (r) {
            setHighlight({ elementId, tooltip, duration, rect: r });
            dismissTimerRef.current = setTimeout(dismiss, duration);
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
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [measureElement, dismiss]);

  // Update position on scroll/resize — depend only on elementId so listeners
  // aren't torn down and re-registered on every position update.
  const activeElementId = highlight?.elementId ?? null;
  useEffect(() => {
    if (!activeElementId) return;

    function updateRect() {
      setHighlight((prev) => {
        if (!prev) return null;
        const r = document.querySelector(`[data-tour="${prev.elementId}"]`)?.getBoundingClientRect() ?? null;
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

  if (!highlight?.rect) return null;

  const { rect, tooltip } = highlight;
  const x = rect.left - PADDING;
  const y = rect.top - PADDING;
  const w = rect.width + PADDING * 2;
  const h = rect.height + PADDING * 2;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] cursor-pointer"
      onClick={dismiss}
      role="presentation"
    >
      {/* Semi-transparent overlay with cutout */}
      <svg className="absolute inset-0 h-full w-full">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={6}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.5)"
          mask={`url(#${maskId})`}
        />
      </svg>

      {/* Pulse ring around the element */}
      <div
        className="absolute rounded-md border-2 border-primary animate-pulse pointer-events-none"
        style={{
          left: x,
          top: y,
          width: w,
          height: h,
        }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute px-3 py-2 rounded-md bg-popover text-popover-foreground text-sm shadow-lg border max-w-xs pointer-events-none"
          style={{
            left: x,
            top: y + h + 8,
          }}
        >
          {tooltip}
        </div>
      )}
    </div>,
    document.body,
  );
}
