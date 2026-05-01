import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
} from "@tabler/icons-react";
import { StorageProviderId } from "@mini-infra/types";
import {
  StorageSwitchPrecheck,
  useStorageSwitchPrecheck,
} from "@/hooks/use-storage-settings";

interface StorageSwitchConfirmDialogProps {
  /** When set, the dialog opens and runs the precheck for this target provider. */
  pendingProviderId: StorageProviderId | null;
  currentProviderId: StorageProviderId | null;
  onCancel: () => void;
  onConfirm: () => void;
  isSwitching?: boolean;
}

const PROVIDER_LABEL: Record<StorageProviderId, string> = {
  azure: "Azure Blob Storage",
  "google-drive": "Google Drive",
};

export function StorageSwitchConfirmDialog(
  props: StorageSwitchConfirmDialogProps,
) {
  // Re-mount the inner body whenever the pending target changes so the
  // acknowledgement checkbox + precheck re-fetch happen cleanly without
  // an effect-driven reset (which trips the no-setState-in-effect rule).
  const key = props.pendingProviderId ?? "closed";
  return <StorageSwitchConfirmDialogInner key={key} {...props} />;
}

function StorageSwitchConfirmDialogInner({
  pendingProviderId,
  currentProviderId,
  onCancel,
  onConfirm,
  isSwitching,
}: StorageSwitchConfirmDialogProps) {
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState(false);

  const {
    data: precheck,
    isLoading: precheckLoading,
    error: precheckError,
  } = useStorageSwitchPrecheck(pendingProviderId, {
    enabled: !!pendingProviderId,
  });

  const open = !!pendingProviderId;
  const targetLabel = pendingProviderId ? PROVIDER_LABEL[pendingProviderId] : "";
  const currentLabel = currentProviderId
    ? PROVIDER_LABEL[currentProviderId]
    : "(no current provider)";

  const hasWarnings = (precheck?.warnings.length ?? 0) > 0;
  const canSwitch = !!precheck?.canSwitch;

  const confirmDisabled =
    !precheck ||
    isSwitching ||
    precheckLoading ||
    !canSwitch ||
    (hasWarnings && !acknowledgedWarnings);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Switch storage provider?</AlertDialogTitle>
          <AlertDialogDescription>
            Switching from{" "}
            <span className="font-medium">{currentLabel}</span> to{" "}
            <span className="font-medium">{targetLabel}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {precheckLoading ? (
            <div className="space-y-2" data-tour="storage-switch-precheck-loading">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : precheckError ? (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertTitle>Failed to compute switch consequences</AlertTitle>
              <AlertDescription>
                {precheckError instanceof Error
                  ? precheckError.message
                  : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : precheck ? (
            <PrecheckBody
              precheck={precheck}
              targetProviderId={pendingProviderId as StorageProviderId}
              currentProviderId={currentProviderId}
            />
          ) : null}

          {hasWarnings && precheck && canSwitch && (
            <label
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700/40 dark:bg-amber-900/20"
              data-tour="storage-switch-acknowledge"
            >
              <Checkbox
                checked={acknowledgedWarnings}
                onCheckedChange={(v) => setAcknowledgedWarnings(v === true)}
                className="mt-0.5"
                aria-label="Acknowledge the warnings above"
              />
              <span>
                I understand the warnings above and want to switch to{" "}
                <span className="font-medium">{targetLabel}</span>.
              </span>
            </label>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSwitching}>Cancel</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              onClick={onConfirm}
              disabled={confirmDisabled}
              data-tour="storage-switch-confirm"
            >
              {isSwitching ? "Switching..." : "Confirm Switch"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface PrecheckBodyProps {
  precheck: StorageSwitchPrecheck;
  targetProviderId: StorageProviderId;
  currentProviderId: StorageProviderId | null;
}

function PrecheckBody({
  precheck,
  targetProviderId,
  currentProviderId,
}: PrecheckBodyProps) {
  const blockReasons = precheck.blockReasons;
  const warnings = precheck.warnings;
  const targetLabel = PROVIDER_LABEL[targetProviderId];
  const currentLabel = currentProviderId
    ? PROVIDER_LABEL[currentProviderId]
    : "(none)";

  return (
    <>
      {blockReasons.length > 0 && (
        <Alert variant="destructive" data-tour="storage-switch-blockers">
          <IconAlertTriangle className="h-4 w-4" />
          <AlertTitle>Switch blocked</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5 space-y-1">
              {blockReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert
          className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-100"
          data-tour="storage-switch-warnings"
        >
          <IconAlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300" />
          <AlertTitle>Warnings</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5 space-y-1">
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Alert className="border-muted-foreground/30 bg-muted/30">
        <IconInfoCircle className="h-4 w-4" />
        <AlertTitle>What changes</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {precheck.postgresBackupHistoryCount > 0 && (
              <li>
                {precheck.postgresBackupHistoryCount} past Postgres backup
                {precheck.postgresBackupHistoryCount === 1 ? "" : "s"} stored on{" "}
                {currentLabel} will become unbrowsable in the UI but remain
                restorable while {currentLabel} is still configured.
              </li>
            )}
            {precheck.selfBackupHistoryCount > 0 && (
              <li>
                {precheck.selfBackupHistoryCount} past self-backup
                {precheck.selfBackupHistoryCount === 1 ? "" : "s"} on{" "}
                {currentLabel} will move out of the active list. Restoring still
                works while {currentLabel} stays configured.
              </li>
            )}
            <li>
              The ACME account key will be regenerated against {targetLabel} on
              the next renewal — auto-renew on the old account stops.
            </li>
            <li>
              You will need to re-pick the location for postgres backups,
              self-backups, and TLS certificates on {targetLabel}.
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      {blockReasons.length === 0 && warnings.length === 0 && (
        <Alert className="border-green-300 bg-green-50 text-green-900 dark:border-green-700/40 dark:bg-green-900/20 dark:text-green-100">
          <IconCircleCheck className="h-4 w-4 text-green-600 dark:text-green-300" />
          <AlertTitle>Ready to switch</AlertTitle>
          <AlertDescription>
            No active certificates, no in-flight operations, and no past backup
            history to consider. Safe to proceed.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
