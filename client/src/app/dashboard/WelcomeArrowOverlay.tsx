import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface LabelDef {
  tourTarget: string;
  label: string;
  /** Where to place the label relative to the target. Defaults to "below". */
  anchor?: "below" | "above";
  requiresAgent?: boolean;
}

interface LabelPosition {
  /** Label pill position (center-x for both anchors) */
  lx: number;
  ly: number;
  /** Arrow endpoint on the target element */
  tx: number;
  ty: number;
  label: string;
  anchor: "below" | "above";
}

const OFFSET = 50;

function computePositions(labels: LabelDef[]): LabelPosition[] {
  const result: LabelPosition[] = [];
  for (const { tourTarget, label, anchor = "below" } of labels) {
    const el = document.querySelector(`[data-tour="${tourTarget}"]`);
    if (!el) continue;

    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;

    if (anchor === "above") {
      // Label sits above the target, arrow points down
      result.push({
        lx: cx,
        ly: r.top - OFFSET,
        tx: cx,
        ty: r.top - 4,
        label,
        anchor,
      });
    } else {
      // Label sits below the target, arrow points up
      result.push({
        lx: cx,
        ly: r.bottom + OFFSET,
        tx: cx,
        ty: r.bottom + 4,
        label,
        anchor,
      });
    }
  }
  return result;
}

export function WelcomeLabelsOverlay({ labels }: { labels: LabelDef[] }) {
  const [positions, setPositions] = useState<LabelPosition[]>([]);
  const [isWide, setIsWide] = useState(
    () => window.matchMedia("(min-width: 768px)").matches,
  );
  const rafRef = useRef(0);

  const measure = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setPositions(computePositions(labels));
    });
  }, [labels]);

  useEffect(() => {
    const timer = setTimeout(measure, 100);

    const mq = window.matchMedia("(min-width: 768px)");
    const handleMq = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener("change", handleMq);

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    const handleTransitionEnd = (e: TransitionEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("[data-sidebar]")
      ) {
        measure();
      }
    };
    document.addEventListener("transitionend", handleTransitionEnd);

    const sidebar = document.querySelector("[data-sidebar]");
    let ro: ResizeObserver | null = null;
    if (sidebar) {
      ro = new ResizeObserver(measure);
      ro.observe(sidebar);
    }

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
      mq.removeEventListener("change", handleMq);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("transitionend", handleTransitionEnd);
      ro?.disconnect();
    };
  }, [measure]);

  if (!isWide || positions.length === 0) return null;

  return createPortal(
    <>
      <svg
        className="fixed inset-0 w-full h-full pointer-events-none z-30"
        style={{ overflow: "visible" }}
      >
        <defs>
          <marker
            id="welcome-arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="7"
            refY="3"
            orient="auto"
          >
            <path
              d="M 0 0 L 8 3 L 0 6 Z"
              className="fill-muted-foreground/40"
            />
          </marker>
        </defs>
        <style>{`
          @keyframes welcome-draw {
            to { stroke-dashoffset: 0; }
          }
          @keyframes welcome-breathe {
            0%, 100% { opacity: 0.85; transform: translate(-50%, 0) scale(1); }
            50%      { opacity: 1;    transform: translate(-50%, 0) scale(1.04); }
          }
        `}</style>
        {positions.map((pos, i) => {
          const dist = Math.sqrt(
            (pos.tx - pos.lx) ** 2 + (pos.ty - pos.ly) ** 2,
          );
          const pathLen = dist * 1.3;

          return (
            <line
              key={i}
              x1={pos.lx}
              y1={pos.ly}
              x2={pos.tx}
              y2={pos.ty}
              stroke="currentColor"
              className="text-muted-foreground/40"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              strokeDashoffset={pathLen}
              markerEnd="url(#welcome-arrowhead)"
              style={{
                animation: `welcome-draw 0.6s ease-out ${0.3 + i * 0.15}s forwards`,
              }}
            />
          );
        })}
      </svg>
      {positions.map((pos, i) => (
        <div
          key={i}
          className="fixed pointer-events-none z-30 whitespace-nowrap rounded-full border border-border/50 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm"
          style={{
            left: pos.lx,
            top: pos.ly,
            transform: "translate(-50%, 0)",
            animation: "welcome-breathe 3s ease-in-out infinite",
            animationDelay: `${i * 0.4}s`,
          }}
        >
          {pos.label}
        </div>
      ))}
    </>,
    document.body,
  );
}

export type { LabelDef };
