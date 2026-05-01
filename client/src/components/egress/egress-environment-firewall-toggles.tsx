/**
 * Compact per-environment egress firewall toggles for the /egress page header.
 *
 * Renders a stacked list of `[env name | switch]` rows in the page header's
 * top-right. The host-singleton firewall agent status lives on
 * /settings-egress-fw-agent and is no longer duplicated here.
 */

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useEnvironments, useUpdateEnvironment } from "@/hooks/use-environments";

function EnvFirewallToggle({
  environmentId,
  environmentName,
  enabled,
  canWrite,
}: {
  environmentId: string;
  environmentName: string;
  enabled: boolean;
  canWrite: boolean;
}) {
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

  const switchControl = (
    <Switch
      checked={enabled}
      onCheckedChange={handleSwitchChange}
      disabled={!canWrite || updateEnvironment.isPending}
      data-tour="environment-egress-firewall-toggle"
      aria-label={`Egress firewall for ${environmentName}`}
    />
  );

  const wrappedSwitch = !canWrite ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{switchControl}</span>
      </TooltipTrigger>
      <TooltipContent>Requires environments:write permission</TooltipContent>
    </Tooltip>
  ) : (
    switchControl
  );

  return (
    <>
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm font-medium">{environmentName}</span>
        {wrappedSwitch}
      </div>

      <AlertDialog
        open={confirmDisableOpen}
        onOpenChange={setConfirmDisableOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disable egress firewall for {environmentName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The kernel-level enforcement layer will be torn down. Egress
              events will stop being logged for this environment until you
              re-enable it. This change is best-effort if the firewall agent is
              offline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateEnvironment.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDisableOpen(false);
                void applyToggle(false);
              }}
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

export function EgressEnvironmentFirewallToggles() {
  const envQuery = useEnvironments({ filters: { page: 1, limit: 100 } });
  const environments = envQuery.data?.environments ?? [];

  if (envQuery.isLoading) {
    return <Skeleton className="h-9 w-40" />;
  }

  if (environments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Egress firewall
      </span>
      <div className="flex flex-col gap-1.5">
        {environments.map((env) => (
          <EnvFirewallToggle
            key={env.id}
            environmentId={env.id}
            environmentName={env.name}
            enabled={env.egressFirewallEnabled ?? false}
            canWrite
          />
        ))}
      </div>
    </div>
  );
}
