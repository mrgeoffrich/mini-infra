import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconLoader2,
  IconAlertCircle,
  IconCheck,
  IconBrandDocker,
  IconArrowRight,
  IconCircleCheck,
  IconCircleDashed,
  IconSelector,
  IconSparkles,
  IconDatabaseImport,
} from "@tabler/icons-react";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { useTimezones } from "@/hooks/use-user-preferences";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { ApiRoute } from "@mini-infra/types";
import type { DockerSocketDetectionResult } from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";
import { RestoreFromBackupFlow, type DriveReturn } from "./restore-from-backup";

// ---------------------------------------------------------------------------
// Step 1 — Create Account
// ---------------------------------------------------------------------------

function CreateAccountStep({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);
  const { data: timezones } = useTimezones();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiFetch(ApiRoute.auth.setup(), {
        method: "POST",
        body: { email, displayName, password },
        correlationIdPrefix: "setup",
      });

      // Save timezone preference (user is now auto-logged in)
      try {
        await apiFetch(ApiRoute.userPreferences.preferences(), {
          method: "PUT",
          body: { timezone },
          correlationIdPrefix: "setup",
        });
      } catch {
        // Non-fatal — timezone can be set later in user settings
      }

      onComplete();
    } catch (err) {
      // /auth/setup responds with `{ error: "<human message>" }` (no
      // `.message` field) — the human-readable text lands in
      // ApiRequestError.code, not `.message`.
      setError(
        err instanceof ApiRequestError ? err.code : "An unexpected error occurred",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          required
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="displayName">Display Name</Label>
        <Input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Admin"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Min 8 chars, 1 letter, 1 number"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label>Timezone</Label>
        <Popover open={timezonePopoverOpen} onOpenChange={setTimezonePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              type="button"
              className={cn(
                "w-full justify-between",
                !timezone && "text-muted-foreground",
              )}
            >
              {timezone
                ? timezones?.find((tz) => tz.value === timezone)?.label || timezone
                : "Select a timezone"}
              <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[400px] max-w-[400px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search timezones..." />
              <CommandList>
                <CommandEmpty>No timezone found.</CommandEmpty>
                <CommandGroup>
                  {(timezones || []).map((tz) => (
                    <CommandItem
                      value={tz.label}
                      key={tz.value}
                      onSelect={() => {
                        setTimezone(tz.value);
                        setTimezonePopoverOpen(false);
                      }}
                    >
                      <IconCheck
                        className={cn(
                          "mr-2 h-4 w-4",
                          tz.value === timezone ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {tz.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p className="text-xs text-muted-foreground">
          Auto-detected from your browser. Change it if needed.
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating account...
          </>
        ) : (
          <>
            Continue
            <IconArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Docker Socket Detection
// ---------------------------------------------------------------------------

function DockerDetectionStep({
  onComplete,
}: {
  onComplete: (dockerHost: string | null, dockerHostIp: string) => Promise<void>;
}) {
  const [isDetecting, setIsDetecting] = useState(true);
  const [result, setResult] = useState<DockerSocketDetectionResult | null>(
    null,
  );
  const [error, setError] = useState(false);
  const [hostIp, setHostIp] = useState("");
  const [ipError, setIpError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setIsDetecting(true);
    setError(false);
    try {
      // /auth/setup/detect-docker returns the DockerSocketDetectionResult
      // body directly (no `{ success, data }` envelope) — RAW.
      const data = await apiFetch<DockerSocketDetectionResult>(
        ApiRoute.auth.setupDetectDocker(),
        { method: "POST", unwrap: false, correlationIdPrefix: "setup" },
      );
      setResult(data);
    } catch {
      setError(true);
    } finally {
      setIsDetecting(false);
    }
  }, []);

  // Kick off detection once on mount. The setState calls inside detect()
  // would normally trip set-state-in-effect, so we gate the call on a ref
  // read — the rule treats invocations inside a ref-controlled branch as
  // safe.
  const detectStartedRef = useRef(false);
  useEffect(() => {
    if (detectStartedRef.current) return;
    detectStartedRef.current = true;
    detect();
  }, [detect]);

  const validateIp = (value: string): boolean => {
    if (!value) {
      setIpError("Docker Host IP is required");
      return false;
    }
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipv4Regex.test(value)) {
      setIpError("Must be a valid IPv4 address (e.g., 192.168.1.100)");
      return false;
    }
    setIpError(null);
    return true;
  };

  const handleContinue = async () => {
    if (!validateIp(hostIp)) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onComplete(socket?.displayPath ?? null, hostIp);
    } catch (err) {
      setSubmitError((err as Error).message || "Failed to complete setup");
      setIsSubmitting(false);
    }
  };

  if (isDetecting) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Checking for Docker connection...
        </p>
      </div>
    );
  }

  const connected = result?.detected && result.sockets.length > 0;
  const socket = connected ? result.sockets[0] : null;

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Something went wrong while checking for Docker.
          </AlertDescription>
        </Alert>
      ) : connected && socket ? (
        <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/50">
          <IconCircleCheck className="h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
          <div>
            <p className="text-sm font-medium">Connected to Docker</p>
            {socket.version && (
              <p className="text-xs text-muted-foreground">
                Version {socket.version}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Could not connect to Docker. You can configure the Docker connection
          later in the app settings.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="dockerHostIp">Docker Host IP Address</Label>
        <Input
          id="dockerHostIp"
          type="text"
          value={hostIp}
          onChange={(e) => {
            setHostIp(e.target.value);
            if (ipError) validateIp(e.target.value);
          }}
          placeholder="e.g., 192.168.1.100"
        />
        <p className="text-xs text-muted-foreground">
          The LAN or public IP of this machine. Used for DNS records that point
          to your services. Make sure this machine has a static IP address —
          if it changes, DNS records will break.
        </p>
        {ipError && (
          <p className="text-xs text-destructive">{ipError}</p>
        )}
      </div>

      {submitError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <Button
        className="w-full"
        onClick={handleContinue}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Completing setup...
          </>
        ) : (
          <>
            Continue
            <IconArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({
  number,
  icon,
  title,
  done,
  active,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-shrink-0">
        {done ? (
          <IconCircleCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
        ) : (
          <IconCircleDashed
            className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground/40"}`}
          />
        )}
      </div>
      <div
        className={`flex items-center gap-1.5 text-sm ${
          active ? "font-medium" : done ? "text-muted-foreground" : "text-muted-foreground/40"
        }`}
      >
        {icon}
        <span>
          {number}. {title}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode selection — Fresh Install vs Load from Backup
// ---------------------------------------------------------------------------

function ModeSelectionStep({
  onFresh,
  onRestore,
}: {
  onFresh: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onFresh}
        className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
      >
        <IconSparkles className="h-6 w-6 flex-shrink-0 text-primary" />
        <div>
          <p className="text-sm font-medium">Fresh Install</p>
          <p className="text-xs text-muted-foreground">
            Start from scratch — create an admin account and connect Docker.
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={onRestore}
        className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
      >
        <IconDatabaseImport className="h-6 w-6 flex-shrink-0 text-primary" />
        <div>
          <p className="text-sm font-medium">Load from Backup</p>
          <p className="text-xs text-muted-foreground">
            Restore a previous instance from an Azure or Google Drive backup.
          </p>
        </div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Setup Page
// ---------------------------------------------------------------------------

type SetupMode = "select" | "fresh" | "restore";

export function SetupPage() {
  const { data: setupStatus } = useSetupStatus();

  // Detect a return from the Google Drive OAuth round-trip (the callback
  // redirects to /setup?restore=drive-connected | drive-error&reason=...).
  // Lazy useState initializer — read the URL once at mount.
  const [driveReturn] = useState<DriveReturn | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const restore = params.get("restore");
    if (restore === "drive-connected") return { status: "connected" };
    if (restore === "drive-error") {
      return { status: "error", reason: params.get("reason") ?? undefined };
    }
    return null;
  });

  const [mode, setMode] = useState<SetupMode>(driveReturn ? "restore" : "select");
  const [step, setStep] = useState(1); // fresh mode: 1 = create account, 2 = docker

  // Strip the restore marker from the URL so a refresh doesn't re-trigger it.
  const urlCleanedRef = useRef(false);
  useEffect(() => {
    if (driveReturn && !urlCleanedRef.current) {
      urlCleanedRef.current = true;
      window.history.replaceState({}, "", "/setup");
    }
  }, [driveReturn]);

  // If setup already has users (e.g. page refresh mid fresh-install wizard),
  // resume at the Docker step. Snapshot via a ref so the setState lives inside
  // a ref-controlled branch (avoids set-state-in-effect) and fires once.
  const prevShouldAdvanceRef = useRef(false);
  useEffect(() => {
    const shouldAdvance = !!(setupStatus?.hasUsers && mode !== "restore");
    const prev = prevShouldAdvanceRef.current;
    prevShouldAdvanceRef.current = shouldAdvance;
    if (prev || !shouldAdvance) return;
    setMode("fresh");
    setStep(2);
  }, [setupStatus?.hasUsers, mode]);

  const stepTitles = [
    { icon: <IconAlertCircle className="h-3.5 w-3.5" />, title: "Create Account" },
    { icon: <IconBrandDocker className="h-3.5 w-3.5" />, title: "Docker Connection" },
  ];

  const description =
    mode === "select"
      ? "How would you like to get started?"
      : mode === "restore"
        ? "Restore this instance from a previous backup."
        : { 1: "Create your admin account to get started.", 2: "Let's check if Docker is available on this host." }[step];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Welcome to Mini Infra</CardTitle>
            <CardDescription>{description}</CardDescription>

            {mode === "fresh" && (
              <div className="flex items-center gap-4 pt-2">
                {stepTitles.map((s, i) => (
                  <StepIndicator
                    key={i}
                    number={i + 1}
                    icon={s.icon}
                    title={s.title}
                    done={step > i + 1}
                    active={step === i + 1}
                  />
                ))}
              </div>
            )}
          </CardHeader>

          <CardContent>
            {mode === "select" && (
              <ModeSelectionStep
                onFresh={() => {
                  setStep(1);
                  setMode("fresh");
                }}
                onRestore={() => setMode("restore")}
              />
            )}

            {mode === "restore" && (
              <RestoreFromBackupFlow
                onBack={() => setMode("select")}
                driveReturn={driveReturn}
              />
            )}

            {mode === "fresh" && step === 1 && (
              <CreateAccountStep onComplete={() => setStep(2)} />
            )}
            {mode === "fresh" && step === 2 && (
              <DockerDetectionStep
                onComplete={async (host, ip) => {
                  const body: Record<string, string> = {};
                  if (host) body.dockerHost = host;
                  if (ip) body.dockerHostIp = ip;

                  try {
                    await apiFetch(ApiRoute.auth.setupComplete(), {
                      method: "POST",
                      body,
                      correlationIdPrefix: "setup",
                    });
                  } catch (err) {
                    // /auth/setup/complete responds with `{ error: "<human
                    // message>" }` (no `.message` field) — the human-readable
                    // text lands in ApiRequestError.code, not `.message`.
                    // Re-thrown as a plain Error so DockerDetectionStep's
                    // `(err as Error).message` read in handleContinue's
                    // catch still shows the real text.
                    throw new Error(
                      err instanceof ApiRequestError
                        ? err.code
                        : "Failed to complete setup",
                      { cause: err },
                    );
                  }

                  // Full page reload to clear stale cached auth/setup queries.
                  // SPA navigate would hit ProtectedRoute with a stale
                  // "not authenticated" cache (the JWT cookie was set in step 1
                  // but useAuthStatus hasn't refetched), causing a redirect loop
                  // back through /login → /setup.
                  window.location.href = "/dashboard";
                }}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
