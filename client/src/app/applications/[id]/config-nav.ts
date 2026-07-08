import { createContext, useContext } from "react";

/**
 * Live state the Configuration page publishes so the shared page nav (rendered
 * by the detail layout) can render Configuration's sub-sections with the same
 * scroll-spy highlight, per-section error dots, and count badges the form
 * tracks internally. The form owns this state (it has the react-hook-form
 * context); the rail only reads it.
 */
export interface ConfigNavState {
  activeId: string;
  erroredIds: Set<string>;
  badges: Record<string, number | undefined>;
  onNavigate: (id: string) => void;
}

export interface ConfigNavContextValue {
  state: ConfigNavState | null;
  setState: (state: ConfigNavState | null) => void;
}

export const ConfigNavContext = createContext<ConfigNavContextValue | null>(
  null,
);

export function useConfigNav(): ConfigNavContextValue {
  const ctx = useContext(ConfigNavContext);
  if (!ctx) {
    throw new Error("useConfigNav must be used within a ConfigNavProvider");
  }
  return ctx;
}
