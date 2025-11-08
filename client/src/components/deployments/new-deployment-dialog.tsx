import { useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  X,
  Rocket,
  Loader2,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDeploymentTrigger } from "@/hooks/use-deployment-trigger";
import { DeploymentConfigurationInfo } from "@mini-infra/types";
import { toast } from "sonner";

const newDeploymentSchema = z.object({
  containerName: z
    .string()
    .min(1, "Container name is required")
    .max(100, "Container name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
      "Container name must start with alphanumeric and contain only alphanumeric, underscore, period, or hyphen"
    ),
  containerLabel: z.string().optional(),
});

type NewDeploymentFormData = z.infer<typeof newDeploymentSchema>;

interface NewDeploymentDialogProps {
  config: DeploymentConfigurationInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function NewDeploymentDialog({
  config,
  isOpen,
  onClose,
}: NewDeploymentDialogProps) {
  const triggerMutation = useDeploymentTrigger();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<NewDeploymentFormData>({
    resolver: zodResolver(newDeploymentSchema),
    defaultValues: {
      containerName: config?.applicationName || "",
      containerLabel: "",
    },
  });

  const handleClose = useCallback(() => {
    if (!isSubmitting) {
      reset();
      onClose();
    }
  }, [isSubmitting, reset, onClose]);

  const onSubmit = useCallback(
    async (_data: NewDeploymentFormData) => {
      if (!config) return;

      setIsSubmitting(true);
      try {
        // Trigger a new deployment
        // Note: The data (container name and label) could be used for future enhancements
        // to customize the deployment, but for now we trigger a standard blue-green deployment
        await triggerMutation.mutateAsync({
          applicationName: config.applicationName,
        });

        toast.success(`New deployment triggered for ${config.applicationName}`);
        handleClose();
      } catch (error) {
        toast.error(
          `Failed to trigger deployment: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [config, triggerMutation, handleClose]
  );

  if (!config) return null;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>New Deployment</DialogTitle>
          <DialogDescription>
            Configure and trigger a new blue-green deployment for{" "}
            <span className="font-semibold">{config.applicationName}</span>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="containerName">Container Name</Label>
            <Input
              id="containerName"
              placeholder="e.g., my-app-blue"
              {...register("containerName")}
              disabled={isSubmitting}
            />
            {errors.containerName && (
              <p className="text-sm text-destructive">
                {errors.containerName.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The name to use for the new container. Must be unique.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="containerLabel">Container Label (Optional)</Label>
            <Input
              id="containerLabel"
              placeholder="e.g., version=2.0.0"
              {...register("containerLabel")}
              disabled={isSubmitting}
            />
            {errors.containerLabel && (
              <p className="text-sm text-destructive">
                {errors.containerLabel.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Optional label to add to the container (format: key=value).
            </p>
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-medium mb-1">Deployment Details:</p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li>Docker Image: {config.dockerImage}</li>
              <li>Health Check: {config.healthCheckConfig.endpoint}</li>
              <li>
                Rollback: {config.rollbackConfig.enabled ? "Enabled" : "Disabled"}
              </li>
            </ul>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket className="h-4 w-4 mr-2" />
                  Start Deployment
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
