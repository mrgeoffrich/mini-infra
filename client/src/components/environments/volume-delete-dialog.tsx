import { EnvironmentVolume } from "@mini-infra/types";
import { useDeleteEnvironmentVolume } from "@/hooks/use-environments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, AlertTriangle, HardDrive } from "lucide-react";

interface VolumeDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  volume: EnvironmentVolume;
  onSuccess?: () => void;
}

export function VolumeDeleteDialog({
  open,
  onOpenChange,
  environmentId,
  volume,
  onSuccess,
}: VolumeDeleteDialogProps) {
  const deleteVolumeMutation = useDeleteEnvironmentVolume();

  const handleDelete = async () => {
    try {
      await deleteVolumeMutation.mutateAsync({
        environmentId,
        volumeId: volume.id,
      });

      toast.success(`Volume "${volume.name}" deleted successfully`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Handle specific error cases
      if (errorMessage.includes("Volume in use")) {
        toast.error("Cannot delete volume that is required by services");
      } else {
        toast.error(`Failed to delete volume: ${errorMessage}`);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Delete Volume
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the volume "{volume.name}"?
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            This action cannot be undone. The volume and all its data will be
            permanently removed from this environment.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <div className="text-sm">
            <span className="font-medium">Volume Name:</span> {volume.name}
          </div>
          <div className="text-sm">
            <span className="font-medium">Driver:</span> {volume.driver}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteVolumeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteVolumeMutation.isPending}
          >
            {deleteVolumeMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Delete Volume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}