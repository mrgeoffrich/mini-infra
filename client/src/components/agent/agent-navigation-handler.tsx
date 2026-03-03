import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Renderless component that listens for agent:navigate CustomEvents
 * and performs client-side navigation. Must be mounted inside a Router context.
 * Optionally dispatches a follow-up agent:highlight event after navigation.
 */
export function AgentNavigationHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleNavigate(e: Event) {
      const { path, highlightElementId, highlightTooltip } = (e as CustomEvent)
        .detail as {
        path: string;
        highlightElementId: string | null;
        highlightTooltip: string | null;
      };

      navigate(path);

      if (highlightElementId) {
        // Short delay for one render cycle; the overlay's retry loop handles
        // elements that take longer to appear after navigation.
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("agent:highlight", {
              detail: {
                elementId: highlightElementId,
                tooltip: highlightTooltip,
                duration: 5000,
              },
            }),
          );
        }, 100);
      }
    }

    window.addEventListener("agent:navigate", handleNavigate);
    return () => {
      window.removeEventListener("agent:navigate", handleNavigate);
    };
  }, [navigate]);

  return null;
}
