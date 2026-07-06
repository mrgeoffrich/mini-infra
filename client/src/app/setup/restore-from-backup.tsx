import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconLoader2,
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowRight,
  IconArrowLeft,
  IconBrandAzure,
  IconBrandGoogleDrive,
  IconDatabase,
  IconFolder,
} from "@tabler/icons-react";
import { apiFetch, ApiRequestError } from "@/lib/api-client";
import { ApiRoute } from "@mini-infra/types";
import type {
  StorageProviderId,
  SetupRestoreLocation,
  SetupRestoreLocationsResponse,
  SetupRestoreBackupItem,
  SetupRestoreBackupsResponse,
} from "@mini-infra/types";

type RestoreStep =
  | "provider"
  | "credentials"
  | "location"
  | "select"
  | "confirm"
  | "restarting";

/** Signal passed down from the setup page after the Drive OAuth redirect. */
export interface DriveReturn {
  status: "connected" | "error";
  reason?: string;
}

function errMessage(err: unknown, fallback: string): string {
  // Our restore endpoints respond `{ success:false, error:"<message>" }` — the
  // human text lands in ApiRequestError.code (see api-client extractCode).
  return err instanceof ApiRequestError ? err.code : fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function RestoreFromBackupFlow({
  onBack,
  driveReturn,
}: {
  onBack: () => void;
  driveReturn?: DriveReturn | null;
}) {
  const [step, setStep] = useState<RestoreStep>("provider");
  const [provider, setProvider] = useState<StorageProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Azure credential input
  const [connectionString, setConnectionString] = useState("");
  // Google Drive credential input
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  // Browsing state
  const [locations, setLocations] = useState<SetupRestoreLocation[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [backups, setBackups] = useState<SetupRestoreBackupItem[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);

  const loadLocations = useCallback(async (p: StorageProviderId) => {
    setBusy(true);
    setError(null);
    try {
      const route =
        p === "azure"
          ? ApiRoute.setupRestore.azureLocations()
          : ApiRoute.setupRestore.googleDriveLocations();
      const data = await apiFetch<SetupRestoreLocationsResponse>(route, {
        correlationIdPrefix: "restore",
      });
      setLocations(data.locations);
    } catch (err) {
      setError(errMessage(err, "Failed to list storage locations"));
    } finally {
      setBusy(false);
    }
  }, []);

  // Enter the location step and (re)load the available containers/folders.
  const goToLocationStep = useCallback(
    (p: StorageProviderId) => {
      setStep("location");
      void loadLocations(p);
    },
    [loadLocations],
  );

  // Resume after the Google Drive OAuth redirect returns to /setup. Gated by a
  // ref so the setState work runs once, on the leading edge (the codebase's
  // accepted pattern for set-state-in-effect).
  const resumeDrive = useCallback(
    (ret: DriveReturn) => {
      setProvider("google-drive");
      if (ret.status === "connected") {
        goToLocationStep("google-drive");
      } else {
        setStep("credentials");
        setError(
          ret.reason
            ? `Google Drive connection failed: ${ret.reason}`
            : "Google Drive connection failed. Please try again.",
        );
      }
    },
    [goToLocationStep],
  );

  const driveHandledRef = useRef(false);
  useEffect(() => {
    if (driveHandledRef.current || !driveReturn) return;
    driveHandledRef.current = true;
    resumeDrive(driveReturn);
  }, [driveReturn, resumeDrive]);

  // ---- Provider selection -------------------------------------------------

  function chooseProvider(p: StorageProviderId) {
    setProvider(p);
    setError(null);
    setStep("credentials");
  }

  // ---- Credentials --------------------------------------------------------

  async function submitAzureCredentials() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(ApiRoute.setupRestore.azureCredentials(), {
        method: "POST",
        body: { connectionString },
        correlationIdPrefix: "restore",
      });
      goToLocationStep("azure");
    } catch (err) {
      setError(errMessage(err, "Failed to validate the connection string"));
    } finally {
      setBusy(false);
    }
  }

  async function submitDriveCredentials() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(ApiRoute.setupRestore.googleDriveCredentials(), {
        method: "POST",
        body: { clientId, clientSecret },
        correlationIdPrefix: "restore",
      });
      // Top-level navigation to Google's consent screen; the callback returns
      // the browser to /setup?restore=drive-connected.
      window.location.href = ApiRoute.setupRestore.googleDriveOauthStart();
    } catch (err) {
      setError(errMessage(err, "Failed to save Google Drive credentials"));
      setBusy(false);
    }
  }

  // ---- Backup selection ---------------------------------------------------

  async function loadBackups(id: string) {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<SetupRestoreBackupsResponse>(
        ApiRoute.setupRestore.backups(),
        {
          method: "POST",
          body: { providerId: provider, locationId: id },
          correlationIdPrefix: "restore",
        },
      );
      setBackups(data.backups);
      setStep("select");
    } catch (err) {
      setError(errMessage(err, "Failed to list backups in that location"));
    } finally {
      setBusy(false);
    }
  }

  function chooseLocation(id: string) {
    setLocationId(id);
    void loadBackups(id);
  }

  // ---- Execute ------------------------------------------------------------

  async function executeRestore() {
    if (!provider || !locationId || !selectedBackup) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(ApiRoute.setupRestore.execute(), {
        method: "POST",
        body: {
          providerId: provider,
          locationId,
          objectName: selectedBackup,
        },
        correlationIdPrefix: "restore",
      });
      setStep("restarting");
    } catch (err) {
      setError(
        errMessage(err, "Failed to start the restore. Please try again."),
      );
      setBusy(false);
    }
  }

  // ---- Render -------------------------------------------------------------

  return (
    <div className="space-y-4">
      {error && step !== "restarting" && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === "provider" && (
        <ProviderStep onChoose={chooseProvider} onBack={onBack} />
      )}

      {step === "credentials" && provider === "azure" && (
        <AzureCredentialsStep
          connectionString={connectionString}
          setConnectionString={setConnectionString}
          busy={busy}
          onSubmit={submitAzureCredentials}
          onBack={() => setStep("provider")}
        />
      )}

      {step === "credentials" && provider === "google-drive" && (
        <DriveCredentialsStep
          clientId={clientId}
          setClientId={setClientId}
          clientSecret={clientSecret}
          setClientSecret={setClientSecret}
          busy={busy}
          onSubmit={submitDriveCredentials}
          onBack={() => setStep("provider")}
        />
      )}

      {step === "location" && (
        <LocationStep
          locations={locations}
          busy={busy}
          onChoose={chooseLocation}
          onBack={() => setStep("credentials")}
        />
      )}

      {step === "select" && (
        <BackupSelectStep
          backups={backups}
          selected={selectedBackup}
          onSelect={setSelectedBackup}
          onContinue={() => setStep("confirm")}
          onBack={() => setStep("location")}
        />
      )}

      {step === "confirm" && (
        <ConfirmStep
          backupName={selectedBackup}
          busy={busy}
          onConfirm={executeRestore}
          onBack={() => setStep("select")}
        />
      )}

      {step === "restarting" && <RestartingStep />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function ProviderStep({
  onChoose,
  onBack,
}: {
  onChoose: (p: StorageProviderId) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose where your backup is stored.
      </p>
      <button
        type="button"
        onClick={() => onChoose("azure")}
        className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
      >
        <IconBrandAzure className="h-6 w-6 flex-shrink-0 text-blue-600" />
        <div>
          <p className="text-sm font-medium">Azure Blob Storage</p>
          <p className="text-xs text-muted-foreground">
            Connect with a storage account connection string.
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={() => onChoose("google-drive")}
        className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
      >
        <IconBrandGoogleDrive className="h-6 w-6 flex-shrink-0 text-green-600" />
        <div>
          <p className="text-sm font-medium">Google Drive</p>
          <p className="text-xs text-muted-foreground">
            Connect with your Google OAuth client credentials.
          </p>
        </div>
      </button>
      <BackLink onBack={onBack} label="Back to install options" />
    </div>
  );
}

function AzureCredentialsStep({
  connectionString,
  setConnectionString,
  busy,
  onSubmit,
  onBack,
}: {
  connectionString: string;
  setConnectionString: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="azure-cs">Azure connection string</Label>
        <Textarea
          id="azure-cs"
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
          rows={4}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          We validate this against Azure before continuing. It is only used to
          read your backup and is replaced by the restored configuration.
        </p>
      </div>
      <StepButtons
        busy={busy}
        onBack={onBack}
        onNext={onSubmit}
        nextLabel="Validate & continue"
        nextDisabled={!connectionString.trim()}
        busyLabel="Validating..."
      />
    </div>
  );
}

function DriveCredentialsStep({
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  busy,
  onSubmit,
  onBack,
}: {
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="drive-client-id">Google OAuth client ID</Label>
        <Input
          id="drive-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxxxxxx.apps.googleusercontent.com"
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="drive-client-secret">Google OAuth client secret</Label>
        <Input
          id="drive-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="GOCSPX-..."
        />
        <p className="text-xs text-muted-foreground">
          You'll be sent to Google to authorise access, then returned here to
          pick a backup. Make sure this instance's URL is registered as an
          authorised redirect URI in your Google Cloud console.
        </p>
      </div>
      <StepButtons
        busy={busy}
        onBack={onBack}
        onNext={onSubmit}
        nextLabel="Connect Google Drive"
        nextDisabled={!clientId.trim() || !clientSecret.trim()}
        busyLabel="Connecting..."
      />
    </div>
  );
}

function LocationStep({
  locations,
  busy,
  onChoose,
  onBack,
}: {
  locations: SetupRestoreLocation[];
  busy: boolean;
  onChoose: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Select the container or folder your backups are stored in.
      </p>
      {busy ? (
        <Spinner label="Loading locations..." />
      ) : locations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No locations found for these credentials.
        </p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {locations.map((loc) => (
            <button
              key={loc.id}
              type="button"
              onClick={() => onChoose(loc.id)}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-accent"
            >
              <IconFolder className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
              <span className="text-sm">{loc.displayName}</span>
            </button>
          ))}
        </div>
      )}
      <BackLink onBack={onBack} label="Back" />
    </div>
  );
}

function BackupSelectStep({
  backups,
  selected,
  onSelect,
  onContinue,
  onBack,
}: {
  backups: SetupRestoreBackupItem[];
  selected: string | null;
  onSelect: (name: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose the backup to restore.
      </p>
      {backups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Mini Infra backups found in this location.
        </p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {backups.map((b) => (
            <button
              key={b.objectName}
              type="button"
              onClick={() => onSelect(b.objectName)}
              className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary ${
                selected === b.objectName
                  ? "border-primary bg-accent"
                  : "hover:bg-accent"
              }`}
            >
              <IconDatabase className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.objectName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(b.lastModified)} · {formatBytes(b.sizeBytes)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
      <StepButtons
        busy={false}
        onBack={onBack}
        onNext={onContinue}
        nextLabel="Continue"
        nextDisabled={!selected}
      />
    </div>
  );
}

function ConfirmStep({
  backupName,
  busy,
  onConfirm,
  onBack,
}: {
  backupName: string | null;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <IconAlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <span className="font-medium">
            This replaces this instance's database and restarts.
          </span>{" "}
          All settings, connected services, and stacks from the backup will be
          applied. After the restart, sign in with the backup's admin account.
          You may need to re-enter your Vault passphrase / unlock Vault to bring
          NATS back online, and review the Docker host settings restored from the
          backup.
        </AlertDescription>
      </Alert>
      {backupName && (
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Restoring from</p>
          <p className="truncate text-sm font-medium">{backupName}</p>
        </div>
      )}
      <StepButtons
        busy={busy}
        onBack={onBack}
        onNext={onConfirm}
        nextLabel="Restore & restart"
        busyLabel="Starting restore..."
        destructive
      />
    </div>
  );
}

/**
 * Terminal step: the server is staging the DB and restarting. Poll the public
 * setup-status endpoint (tolerating the downtime window) and redirect to
 * /login once the restored instance reports setup complete.
 */
function RestartingStep() {
  const [timedOut, setTimedOut] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    const deadline = Date.now() + 3 * 60 * 1000;

    (async () => {
      // Give the server a moment to begin shutting down before polling.
      await new Promise((r) => setTimeout(r, 4000));
      while (!cancelled && Date.now() < deadline) {
        try {
          const status = await apiFetch<{ setupComplete: boolean }>(
            ApiRoute.auth.setupStatus(),
            { unwrap: false, timeoutMs: 4000, correlationIdPrefix: "restore" },
          );
          if (status?.setupComplete) {
            window.location.href = "/login";
            return;
          }
        } catch {
          // Server is restarting — keep polling.
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!cancelled) setTimedOut(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (timedOut) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          The restore is taking longer than expected. Check the container logs,
          then reload this page — if the restore succeeded you'll be taken to
          the sign-in screen.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm font-medium">Restoring and restarting…</p>
      <p className="text-xs text-muted-foreground">
        This can take a minute. The page will reconnect and take you to the
        sign-in screen automatically.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <IconLoader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function BackLink({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function StepButtons({
  busy,
  onBack,
  onNext,
  nextLabel,
  busyLabel,
  nextDisabled,
  destructive,
}: {
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  busyLabel?: string;
  nextDisabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
        <IconArrowLeft className="mr-1 h-4 w-4" />
        Back
      </Button>
      <Button
        type="button"
        className="flex-1"
        variant={destructive ? "destructive" : "default"}
        onClick={onNext}
        disabled={busy || nextDisabled}
      >
        {busy ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            {busyLabel ?? "Working..."}
          </>
        ) : (
          <>
            {nextLabel}
            <IconArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
