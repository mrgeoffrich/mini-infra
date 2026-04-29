import { useState } from "react";
import { IconShield } from "@tabler/icons-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { toast } from "sonner";
import { useUpdateEnvironment } from "@/hooks/use-environments";

export interface EgressFirewallCardProps {
  environmentId: string;
  environmentName?: string;
  enabled: boolean;
  isLoading: boolean;
  canWrite: boolean;
  /** Compact mode renders a slim card without the long description, useful for the all-environments fleet view. */
  compact?: boolean;
}

// NOTE: server-side, the egressFirewallEnabled PUT is best-effort with
// respect to the fw-agent push — the route returns 200 once the DB write
// succeeds, even if the agent is unreachable.
export function EgressFirewallCard({
  environmentId,
  environmentName,
  enabled,
  isLoading,
  canWrite,
  compact = false,
}: EgressFirewallCardProps) {
  const updateEnvironment = useUpdateEnvironment();
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);

  const applyToggle = async (nextValue: boolean) => {
    try {
      await updateEnvironment.mutateAsync({
        id: environmentId,
        request: { egressFirewallEnabled: nextValue },
      });
      toast.success(
        nextValue
          ? "Egress firewall enabled — applying to running stacks"
          : "Egress firewall disabled",
      );
    } catch (err) {
      toast.error(
        `Failed to update egress firewall: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  const handleSwitchChange = (next: boolean) => {
    if (!next && enabled) {
      setConfirmDisableOpen(true);
      return;
    }
    void applyToggle(next);
  };

  const handleConfirmDisable = async () => {
    setConfirmDisableOpen(false);
    await applyToggle(false);
  };

  const switchControl = (
    <Switch
      checked={enabled}
      onCheckedChange={handleSwitchChange}
      disabled={!canWrite || updateEnvironment.isPending || isLoading}
      data-tour="environment-egress-firewall-toggle"
      aria-label={`Egress firewall${environmentName ? ` for ${environmentName}` : ""}`}
    />
  );

  const wrappedSwitch =
    !canWrite ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{switchControl}</span>
        </TooltipTrigger>
        <TooltipContent>
          Requires environments:write permission
        </TooltipContent>
      </Tooltip>
    ) : (
      switchControl
    );

  return (
    <>
      <Card>
        <CardHeader
          className={`flex flex-row items-start justify-between space-y-0 gap-4 ${
            compact ? "py-3" : ""
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconShield className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Egress Firewall</CardTitle>
              {!compact && (
                <p className="text-sm text-muted-foreground mt-1">
                  Kernel-level enforcement for outbound traffic. Currently
                  runs in observe mode — events are logged, no traffic is
                  dropped.
                </p>
              )}
              {compact && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {enabled ? "Enabled" : "Disabled"}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center pt-1">
            {isLoading ? <Skeleton className="h-5 w-9" /> : wrappedSwitch}
          </div>
        </CardHeader>
      </Card>

      <AlertDialog
        open={confirmDisableOpen}
        onOpenChange={setConfirmDisableOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disable egress firewall
              {environmentName ? ` for ${environmentName}` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The kernel-level enforcement layer will be torn down. Egress
              events will stop being logged for this environment until you
              re-enable it. This change is best-effort if the firewall agent
              is offline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateEnvironment.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDisable}
              disabled={updateEnvironment.isPending}
            >
              Disable firewall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
