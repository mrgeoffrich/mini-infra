import { useMemo, useState, type ReactNode } from "react";
import { ConfigNavContext, type ConfigNavState } from "./config-nav";

export function ConfigNavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfigNavState | null>(null);
  const value = useMemo(() => ({ state, setState }), [state]);
  return (
    <ConfigNavContext.Provider value={value}>
      {children}
    </ConfigNavContext.Provider>
  );
}
