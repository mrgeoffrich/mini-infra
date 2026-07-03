import { IconLoader2 } from "@tabler/icons-react";
import { useSocketReconnecting } from "@/hooks/use-socket";

/**
 * Global "reconnecting to server…" banner.
 *
 * Surfaces the one signal the app previously dropped silently: the
 * browser↔backend Socket.IO link went down (server restart/deploy, network
 * blip) and the client is retrying. Renders nothing until a connection has
 * been established at least once and then lost — see
 * `useSocketReconnecting()` for the "has ever connected" latch that
 * prevents this from flashing during the very first page-load handshake.
 *
 * Mounted once, app-wide, in `AppLayout` so every authenticated page shows
 * it. Purely presentational/non-blocking: a slim top strip, not a modal —
 * the rest of the UI stays interactive (any actions will simply keep
 * failing/retrying via the existing HTTP/socket resilience until the link
 * is back).
 */
export function ReconnectingBanner() {
  const reconnecting = useSocketReconnecting();

  if (!reconnecting) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 flex w-full items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      <IconLoader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Reconnecting to server…</span>
    </div>
  );
}
