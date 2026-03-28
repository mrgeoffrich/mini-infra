import { IconLoader2, IconRefresh } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useRedeployApplication } from "@/hooks/use-applications";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type { StackTemplateInfo, StackInfo } from "@mini-infra/types";

interface UpdateApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: StackTemplateInfo | null;
  stack: StackInfo | null;
}

export function UpdateApplicationDialog({
  open,
  onOpenChange,
  application,
  stack,
}: UpdateApplicationDialogProps) {
  const redeployApplication = useRedeployApplication();
  const { registerTask } = useTaskTracker();

  const handleUpdate = async () => {
    if (!stack) return;

    try {
      registerTask({
        id: stack.id,
        type: "stack-update",
        label: `Updating ${application?.displayName ?? application?.name ?? "application"}`,
        channel: Channel.STACKS,
      });
      await redeployApplication.mutateAsync(stack.id);
      onOpenChange(false);
    } catch {
      // Error handled by mutation's onError
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconRefresh className="h-5 w-5" />
            Update Application
          </DialogTitle>
          <DialogDescription>
            This will pull the latest image and redeploy &quot;{application?.displayName ?? application?.name}&quot;.
            Web services will be updated with zero downtime.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleUpdate}
            disabled={redeployApplication.isPending}
          >
            {redeployApplication.isPending && (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
