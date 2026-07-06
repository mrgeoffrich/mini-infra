import { ReactNode, useEffect, useRef, useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import { ApiRoute } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

/** Delay before the first retry after a failed `/health` probe. */
const INITIAL_RETRY_DELAY_MS = 750;
/** Cap on the exponential backoff between retries. */
const MAX_RETRY_DELAY_MS = 5000;
/** Failed-probe count after which the UI adds a "still starting up" hint. */
const SLOW_START_ATTEMPT_THRESHOLD = 4;

interface ServerReadyGateProps {
  children: ReactNode;
}

/**
 * Cold-start readiness gate (Phase 8 of
 * docs/planning/not-shipped/frontend-backend-contract-plan.md).
 *
 * Mounted ABOVE `AuthProvider` in `App.tsx`, before any authed query can
 * fire. Previously, a cold start (e.g. mid-deploy, backend container still
 * booting) meant the auth-status query fired immediately, failed with a raw
 * connection-refused error, and `ProtectedRoute`/`AuthErrorBoundary`
 * surfaced a confusing "Authentication Error" card with a manual reload
 * button. This component instead polls the auth-exempt `/health` endpoint
 * with backoff BEFORE any of that mounts, showing an auto-retrying
 * "waiting for the server" screen that resolves itself the moment the
 * backend comes up — no reload required.
 *
 * Deliberately a bare `useEffect` + `useState` poll loop rather than
 * `useQuery`: this sits above `AuthProvider`, which is what constructs the
 * app's single `QueryClient` (see `auth-context.tsx`), so no `QueryClient`
 * is available yet at this point in the tree.
 *
 * Gates ONLY the initial load. Once `/health` resolves successfully once,
 * `ready` flips to `true` for good and children render permanently — a
 * later mid-session server blip is already covered by the Phase 6
 * socket-reconnecting banner and the Phase 5 401/retry handling, so this
 * gate does not re-block on navigation or on a later `/health` failure.
 */
export function ServerReadyGate({ children }: ServerReadyGateProps) {
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function probe(attemptIndex: number) {
      try {
        // `unwrap: false` — `/health` returns a raw (non-enveloped) body.
        // Any resolved (non-throwing) call means the server answered with
        // a 2xx; we deliberately don't hard-depend on the exact response
        // shape beyond that, so this can't get stuck if the health payload
        // ever evolves.
        await apiFetch(ApiRoute.health(), {
          unwrap: false,
          correlationIdPrefix: "server-ready",
        });
        if (!cancelledRef.current) {
          setReady(true);
        }
      } catch {
        // ANY failure — a raw connection-refused TypeError from a down
        // server, a timeout, or a non-2xx thrown by apiFetch — means "keep
        // waiting". This is a "wait for the server" state, not a failure
        // state, so retry forever with backoff rather than giving up.
        if (cancelledRef.current) {
          return;
        }
        setAttempt(attemptIndex + 1);
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** attemptIndex,
          MAX_RETRY_DELAY_MS,
        );
        timeoutId = setTimeout(() => {
          void probe(attemptIndex + 1);
        }, delay);
      }
    }

    void probe(0);

    return () => {
      cancelledRef.current = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  if (ready) {
    return <>{children}</>;
  }

  return (
    <ServerWaitingScreen
      showSlowStartHint={attempt >= SLOW_START_ATTEMPT_THRESHOLD}
    />
  );
}

function ServerWaitingScreen({
  showSlowStartHint,
}: {
  showSlowStartHint: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="min-h-screen flex items-center justify-center bg-background px-4"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <IconLoader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-lg font-medium text-foreground">
          Waiting for server…
        </p>
        {showSlowStartHint && (
          <p className="max-w-sm text-sm text-muted-foreground">
            Still starting up — this can take a little longer during a
            deploy or restart.
          </p>
        )}
      </div>
    </div>
  );
}
