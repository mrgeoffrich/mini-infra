import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { IconAlertTriangle, IconUnlink } from "@tabler/icons-react";
import { toast } from "sonner";
import { StorageProviderId } from "@mini-infra/types";
import { useForgetStorageProvider } from "@/hooks/use-storage-settings";

interface StorageForgetProviderButtonProps {
  /** The provider to disconnect. Must NOT be the currently active provider. */
  provider: StorageProviderId;
  /** Pretty label for the provider — used in copy. */
  providerLabel: string;
  /** Disable the button (e.g., not configured at all). */
  disabled?: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "probing" }
  // Referencing rows — render destructive warning + acknowledge checkbox.
  | {
      kind: "needs-ack";
      referencingRowCount: number;
      postgresBackupHistoryCount: number;
      selfBackupHistoryCount: number;
    }
  | { kind: "error"; message: string };

interface ForgetErrorData {
  referencingRowCount?: number;
  postgresBackupHistoryCount?: number;
  selfBackupHistoryCount?: number;
}

interface ForgetError extends Error {
  status?: number;
  code?: string;
  data?: ForgetErrorData;
}

function isForgetError(err: unknown): err is ForgetError {
  return err instanceof Error;
}

/**
 * Renders a destructive "Disconnect entirely" action.
 *
 * Two-step flow:
 *  1. On open, fire `forget(force=false)` to discover whether any backup
 *     history rows reference this provider. The endpoint returns 200 if zero
 *     rows reference the provider (the disconnect already succeeded), or 409
 *     with `referencingRowCount` if it refused. The count comes from the
 *     server's own count of rows where `storageProviderAtCreation === provider`
 *     — not the *active* provider's count, which is what the switch-precheck
 *     endpoint reports.
 *  2. If 409: show destructive warning + acknowledgement checkbox; on
 *     confirm, fire `forget(force=true)` to actually wipe the config.
 *  3. If 200: nothing left to do — the disconnect already happened.
 */
export function StorageForgetProviderButton({
  provider,
  providerLabel,
  disabled,
}: StorageForgetProviderButtonProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [acknowledged, setAcknowledged] = useState(false);
  // Token guards against a stale precheck response landing after the user
  // closes-and-reopens the dialog (we'd otherwise overwrite a fresh phase
  // with the previous run's outcome).
  const probeTokenRef = useRef(0);
  const forget = useForgetStorageProvider();

  const startPrecheck = () => {
    const token = ++probeTokenRef.current;
    setPhase({ kind: "probing" });
    setAcknowledged(false);
    forget
      .mutateAsync({ provider, force: false })
      .then(() => {
        if (probeTokenRef.current !== token) return;
        // 200 means the server already wiped the config (no referencing rows).
        toast.success(`${providerLabel} disconnected`);
        setOpen(false);
        setPhase({ kind: "idle" });
      })
      .catch((err: unknown) => {
        if (probeTokenRef.current !== token) return;
        if (isForgetError(err) && err.status === 409 && err.data) {
          const ref = err.data.referencingRowCount ?? 0;
          setPhase({
            kind: "needs-ack",
            referencingRowCount: ref,
            postgresBackupHistoryCount:
              err.data.postgresBackupHistoryCount ?? 0,
            selfBackupHistoryCount: err.data.selfBackupHistoryCount ?? 0,
          });
          return;
        }
        const message = isForgetError(err)
          ? err.message
          : `Failed to probe ${providerLabel}`;
        setPhase({ kind: "error", message });
      });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      startPrecheck();
    } else {
      // Invalidate any in-flight probe and reset state so the next open is fresh.
      probeTokenRef.current++;
      setPhase({ kind: "idle" });
      setAcknowledged(false);
    }
  };

  const handleForceConfirm = async () => {
    try {
      await forget.mutateAsync({ provider, force: true });
      toast.success(`${providerLabel} disconnected`);
      setOpen(false);
      setPhase({ kind: "idle" });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : `Failed to disconnect ${providerLabel}`,
      );
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={disabled}
          data-tour={`storage-forget-${provider}`}
        >
          <IconUnlink className="h-4 w-4 mr-2" />
          Disconnect entirely
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Disconnect {providerLabel} entirely?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This wipes the stored credentials for {providerLabel}. After this
            action, any backups originally written to {providerLabel} will no
            longer be restorable through Mini Infra.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          {phase.kind === "probing" ? (
            <Skeleton className="h-16" />
          ) : phase.kind === "needs-ack" ? (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {phase.referencingRowCount} backup history row
                {phase.referencingRowCount === 1 ? "" : "s"} will be orphaned
              </AlertTitle>
              <AlertDescription>
                <p className="mb-2">
                  Disconnecting now means these backups can no longer be
                  restored via Mini Infra:
                </p>
                <ul className="list-disc pl-5 text-sm space-y-1">
                  {phase.postgresBackupHistoryCount > 0 && (
                    <li>
                      {phase.postgresBackupHistoryCount} Postgres backup
                      {phase.postgresBackupHistoryCount === 1 ? "" : "s"}
                    </li>
                  )}
                  {phase.selfBackupHistoryCount > 0 && (
                    <li>
                      {phase.selfBackupHistoryCount} self-backup
                      {phase.selfBackupHistoryCount === 1 ? "" : "s"}
                    </li>
                  )}
                </ul>
                <p className="mt-2 text-xs">
                  The backup files themselves are not deleted from{" "}
                  {providerLabel} — only the link from Mini Infra is severed.
                </p>
                <label
                  className="mt-3 flex items-start gap-2 text-xs font-medium text-foreground"
                  data-tour={`storage-forget-${provider}-acknowledge`}
                >
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={(checked) =>
                      setAcknowledged(checked === true)
                    }
                  />
                  <span>
                    I understand that the {phase.referencingRowCount} backup
                    history row
                    {phase.referencingRowCount === 1 ? "" : "s"} above will
                    become unrestorable from Mini Infra.
                  </span>
                </label>
              </AlertDescription>
            </Alert>
          ) : phase.kind === "error" ? (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertTitle>Could not probe {providerLabel}</AlertTitle>
              <AlertDescription>{phase.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={forget.isPending}>
            Cancel
          </AlertDialogCancel>
          {phase.kind === "needs-ack" && (
            <Button
              variant="destructive"
              onClick={handleForceConfirm}
              disabled={!acknowledged || forget.isPending}
              data-tour={`storage-forget-${provider}-confirm`}
            >
              {forget.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
