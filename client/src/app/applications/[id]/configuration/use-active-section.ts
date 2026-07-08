import { useEffect, useState } from "react";
import { sectionAnchorId } from "./section-meta";

/**
 * Tracks which section is currently in view so the rail can highlight it.
 * Uses an IntersectionObserver band near the top of the viewport; the section
 * whose heading sits highest within that band wins.
 */
export function useActiveSection(ids: string[]): string {
  const [activeId, setActiveId] = useState(ids[0] ?? "");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-section-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }
        if (visible.size === 0) return;
        const topMost = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        setActiveId(topMost[0]);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );

    for (const id of ids) {
      const el = document.getElementById(sectionAnchorId(id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}
