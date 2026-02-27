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
        // Delay to allow the page to render before highlighting
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
        }, 500);
      }
    }

    window.addEventListener("agent:navigate", handleNavigate);
    return () => {
      window.removeEventListener("agent:navigate", handleNavigate);
    };
  }, [navigate]);

  return null;
}
