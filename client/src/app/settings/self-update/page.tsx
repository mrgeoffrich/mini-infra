import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  IconAlertCircle,
  IconCheck,
  IconDeviceFloppy,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconRotate,
  IconX,
} from "@tabler/icons-react";
import { toastWithCopy } from "@/lib/toast-utils";
import {
  useSelfUpdateConfig,
  useSelfUpdateCheck,
  useSaveUpdateConfig,
  useTriggerUpdate,
  useIsUpdateActive,
  type SelfUpdateStatus,
} from "@/hooks/use-self-update";

// ---------------------------------------------------------------------------
// Config form schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  allowedRegistryPattern: z
    .string()
    .min(1, "Allowed registry pattern is required")
    .regex(/:\*$/, 'Must end with ":*" (e.g. "ghcr.io/user/repo:*")'),
  sidecarImage: z.string().min(1, "Sidecar image is required"),
  healthCheckTimeoutMs: z.coerce.number().int().min(5000).max(300000),
  gracefulStopSeconds: z.coerce.number().int().min(5).max(120),
});

type ConfigFormData = z.output<typeof configSchema>;
type ConfigFormInput = z.input<typeof configSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<SelfUpdateStatus["state"], string> = {
  idle: "Idle",
  checking: "Checking for updates...",
  pulling: "Pulling new image...",
  inspecting: "Inspecting container...",
  stopping: "Stopping current container...",
  creating: "Creating new container...",
  "health-checking": "Health-checking new container...",
  complete: "Update complete",
  "rolling-back": "Rolling back...",
  "rollback-complete": "Rollback complete",
  failed: "Update failed",
};

function StateBadge({ state }: { state: SelfUpdateStatus["state"] }) {
  const variant =
    state === "complete"
      ? "default"
      : state === "failed" || state === "rollback-complete"
        ? "destructive"
        : "secondary";

  return <Badge variant={variant}>{STATE_LABELS[state] ?? state}</Badge>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SelfUpdateSettingsPage() {
  const [triggerTag, setTriggerTag] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Hooks
  const { data: configData, isLoading: configLoading } = useSelfUpdateConfig();
  const saveConfig = useSaveUpdateConfig();
  const checkUpdate = useSelfUpdateCheck();
  const triggerUpdate = useTriggerUpdate();
  const {
    isActive,
    state,
    targetTag,
    progress,
    error: updateError,
    isReconnecting,
  } = useIsUpdateActive();

  // Form
  const form = useForm<ConfigFormInput, unknown, ConfigFormData>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      allowedRegistryPattern: "",
      sidecarImage: "",
      healthCheckTimeoutMs: 60000,
      gracefulStopSeconds: 30,
    },
    mode: "onChange",
  });

  // Populate form when config loads
  useEffect(() => {
    if (configData?.config) {
      const c = configData.config;
      form.reset({
        allowedRegistryPattern: c.allowedRegistryPattern ?? "",
        sidecarImage: c.sidecarImage ?? "",
        healthCheckTimeoutMs: c.healthCheckTimeoutMs ?? 60000,
        gracefulStopSeconds: c.gracefulStopSeconds ?? 30,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- form.reset is stable; only re-run when server data changes
  }, [configData]);

  // Handlers
  const handleSaveConfig = async (data: ConfigFormData) => {
    try {
      await saveConfig.mutateAsync(data);
      toastWithCopy.success("Self-update configuration saved");
    } catch (err) {
      toastWithCopy.error(
        err instanceof Error ? err.message : "Failed to save",
      );
    }
  };

  const handleCheckDocker = () => {
    checkUpdate.mutate(undefined, {
      onSuccess: (data) => {
        if (data.available) {
          toastWithCopy.success(
            data.configured
              ? "Running in Docker and configured for updates"
              : "Running in Docker but not yet configured",
          );
        } else {
          toastWithCopy.warning(data.reason ?? "Self-update not available");
        }
      },
      onError: (err) => {
        toastWithCopy.error(err.message);
      },
    });
  };

  const handleTriggerUpdate = () => {
    if (!triggerTag.trim()) return;
    setConfirmOpen(true);
  };

  const handleConfirmUpdate = () => {
    setConfirmOpen(false);
    triggerUpdate.mutate(triggerTag.trim(), {
      onSuccess: () => {
        toastWithCopy.success(
          "Update initiated. The server will restart shortly.",
        );
        setTriggerTag("");
      },
      onError: (err) => {
        toastWithCopy.error(err.message);
      },
    });
  };

  // -------------------------------------------------------------------------
  // Update in progress overlay
  // -------------------------------------------------------------------------

  if (isActive) {
    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2 text-xl">
              <IconRefresh className="h-6 w-6 animate-spin" />
              Updating Mini Infra
            </CardTitle>
            <CardDescription>
              {targetTag && <>Updating to {targetTag}</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Status */}
            <div className="flex items-center justify-center">
              {state && <StateBadge state={state} />}
            </div>

            {/* Progress bar for image pull */}
            {state === "pulling" && progress !== undefined && (
              <div className="space-y-2">
                <Progress value={progress} />
                <p className="text-center text-sm text-muted-foreground">
                  {progress}% downloaded
                </p>
              </div>
            )}

            {/* Reconnection notice */}
            {isReconnecting && (
              <Alert>
                <IconLoader2 className="h-4 w-4 animate-spin" />
                <AlertDescription>
                  The server is restarting. Waiting for it to come back
                  online...
                </AlertDescription>
              </Alert>
            )}

            {/* Step indicator */}
            <div className="space-y-3">
              {(
                [
                  "pulling",
                  "inspecting",
                  "stopping",
                  "creating",
                  "health-checking",
                ] as const
              ).map((step) => {
                const steps = [
                  "pulling",
                  "inspecting",
                  "stopping",
                  "creating",
                  "health-checking",
                ];
                const currentIdx = state ? steps.indexOf(state) : -1;
                const stepIdx = steps.indexOf(step);
                const isDone = currentIdx > stepIdx;
                const isCurrent = state === step;

                return (
                  <div
                    key={step}
                    className="flex items-center gap-3 text-sm"
                  >
                    {isDone ? (
                      <IconCheck className="h-4 w-4 text-green-500" />
                    ) : isCurrent ? (
                      <IconLoader2 className="h-4 w-4 animate-spin text-blue-500" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border border-muted-foreground/30" />
                    )}
                    <span
                      className={
                        isCurrent
                          ? "font-medium"
                          : isDone
                            ? "text-muted-foreground"
                            : "text-muted-foreground/50"
                      }
                    >
                      {STATE_LABELS[step]}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Last update result banner
  // -------------------------------------------------------------------------

  const showResultBanner =
    state === "complete" ||
    state === "rollback-complete" ||
    state === "failed";

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  if (configLoading) {
    return (
      <div className="container mx-auto max-w-4xl space-y-6 py-8">
        <div className="space-y-1">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Main UI
  // -------------------------------------------------------------------------

  return (
    <div className="container mx-auto max-w-4xl space-y-6 py-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <IconDownload className="h-6 w-6" />
          <h1 className="text-2xl font-bold tracking-tight">
            System Update
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Update Mini Infra to a new version via the sidecar container mechanism
        </p>
      </div>

      {/* Last update result */}
      {showResultBanner && (
        <Alert
          variant={state === "complete" ? "default" : "destructive"}
        >
          {state === "complete" ? (
            <IconCheck className="h-4 w-4" />
          ) : (
            <IconX className="h-4 w-4" />
          )}
          <AlertDescription>
            {state === "complete" && (
              <>
                Successfully updated
                {targetTag && <> to <strong>{targetTag}</strong></>}.
              </>
            )}
            {state === "rollback-complete" && (
              <>
                Update failed and was rolled back.
                {updateError && <> Reason: {updateError}</>}
              </>
            )}
            {state === "failed" && (
              <>
                Update failed.
                {updateError && <> Reason: {updateError}</>}
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Trigger Update Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconRotate className="h-5 w-5" />
            Trigger Update
          </CardTitle>
          <CardDescription>
            Enter the target tag and initiate an update. The full image
            reference is built from the configured registry pattern. The server
            will restart during this process.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckDocker}
              disabled={checkUpdate.isPending}
            >
              {checkUpdate.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconRefresh className="h-4 w-4 mr-2" />
              )}
              Check Docker Status
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="e.g. v2.1.0 or latest"
              value={triggerTag}
              onChange={(e) => setTriggerTag(e.target.value)}
            />
            <Button
              onClick={handleTriggerUpdate}
              disabled={
                !triggerTag.trim() || triggerUpdate.isPending
              }
            >
              {triggerUpdate.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <IconDownload className="h-4 w-4 mr-2" />
              )}
              Update
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Enter an image tag. The full image reference is derived from the
            configured registry pattern.
          </p>
        </CardContent>
      </Card>

      {/* Configuration Card */}
      <Card>
        <CardHeader>
          <CardTitle>Update Configuration</CardTitle>
          <CardDescription>
            Configure the sidecar image, allowed registry, and health check
            parameters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSaveConfig)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="allowedRegistryPattern"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Allowed Registry Pattern</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="ghcr.io/mrgeoffrich/mini-infra:*"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Glob pattern for allowed image references. Use * as a
                      wildcard for the tag.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sidecarImage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sidecar Image</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="ghcr.io/mrgeoffrich/mini-infra-sidecar:latest"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Docker image for the update sidecar container.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="healthCheckTimeoutMs"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Health Check Timeout (ms)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value as number} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="gracefulStopSeconds"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Graceful Stop Timeout (s)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value as number} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <Button
                type="submit"
                disabled={saveConfig.isPending || !form.formState.isDirty}
              >
                {saveConfig.isPending ? (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <IconDeviceFloppy className="h-4 w-4 mr-2" />
                )}
                Save Configuration
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm System Update</DialogTitle>
            <DialogDescription>
              This will update Mini Infra to{" "}
              <strong>{triggerTag}</strong>. The server will restart during
              this process. If the new version fails health checks, the
              previous version will be automatically restored.
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              All active connections will be interrupted during the update.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmUpdate}>
              <IconDownload className="h-4 w-4 mr-2" />
              Start Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
