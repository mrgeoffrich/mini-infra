import { useEffect, useState } from "react";

// A brief infra blip (e.g. a container restarting) shouldn't collapse large
// gated UI sections and shift page scroll - ride out anything shorter than this.
export const INFRA_BLIP_GRACE_MS = 20000;

/**
 * Returns `value`, but delays any transition to `false` by `graceMs`. A value
 * that flips false and recovers to true within the grace window never becomes
 * visible to the caller.
 */
export function useDebouncedFalse(value: boolean, graceMs: number): boolean {
  const [debounced, setDebounced] = useState(value);
  const [prevValue, setPrevValue] = useState(value);

  // Adopt `true` immediately (React's "adjusting state when a prop changes"
  // pattern - avoids a synchronous setState inside the effect below).
  if (value !== prevValue) {
    setPrevValue(value);
    if (value) {
      setDebounced(true);
    }
  }

  useEffect(() => {
    if (value) return undefined;
    const timer = setTimeout(() => setDebounced(false), graceMs);
    return () => clearTimeout(timer);
  }, [value, graceMs]);

  return debounced;
}
