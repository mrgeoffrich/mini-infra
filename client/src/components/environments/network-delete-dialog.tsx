import { EnvironmentNetwork } from "@mini-infra/types";
import { useDeleteEnvironmentNetwork } from "@/hooks/use-environments";
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
import { IconLoader2, IconAlertTriangle, IconNetwork } from "@tabler/icons-react";

interface NetworkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  network: EnvironmentNetwork;
  onSuccess?: () => void;
}

export function NetworkDeleteDialog({
  open,
  onOpenChange,
  environmentId,
  network,
  onSuccess,
}: NetworkDeleteDialogProps) {
  const deleteNetworkMutation = useDeleteEnvironmentNetwork();

  const handleDelete = async () => {
    try {
      await deleteNetworkMutation.mutateAsync({
        environmentId,
        networkId: network.id,
      });

      toast.success(`Network "${network.name}" deleted successfully`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Handle specific error cases
      if (errorMessage.includes("Network in use")) {
        toast.error("Cannot delete network that is required by services");
      } else {
        toast.error(`Failed to delete network: ${errorMessage}`);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconNetwork className="h-5 w-5" />
            Delete Network
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the network "{network.name}"?
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <IconAlertTriangle className="h-4 w-4" />
          <AlertDescription>
            This action cannot be undone. The network will be permanently removed
            from this environment.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <div className="text-sm">
            <span className="font-medium">Network Name:</span> {network.name}
          </div>
          <div className="text-sm">
            <span className="font-medium">Driver:</span> {network.driver}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteNetworkMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteNetworkMutation.isPending}
          >
            {deleteNetworkMutation.isPending && (
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Delete Network
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}