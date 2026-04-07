import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Renderless component that listens for agent:navigate CustomEvents
 * and performs client-side navigation. Must be mounted inside a Router context.
 */
export function AgentNavigationHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleNavigate(e: Event) {
      const { path } = (e as CustomEvent).detail as { path: string };
      navigate(path);
    }

    window.addEventListener("agent:navigate", handleNavigate);
    return () => {
      window.removeEventListener("agent:navigate", handleNavigate);
    };
  }, [navigate]);

  return null;
}
