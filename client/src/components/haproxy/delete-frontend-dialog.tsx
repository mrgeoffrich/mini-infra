import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
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
import { HAProxyFrontendInfo } from "@mini-infra/types";

interface DeleteFrontendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frontend: HAProxyFrontendInfo | null;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteFrontendDialog({
  open,
  onOpenChange,
  frontend,
  isDeleting,
  onConfirm,
  onCancel,
}: DeleteFrontendDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <IconAlertTriangle className="h-5 w-5 text-destructive" />
            <AlertDialogTitle>Delete Manual Frontend</AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              <p>
                Are you sure you want to delete the frontend "
                {frontend?.frontendName}"? The following will be permanently
                removed:
              </p>
              <ul className="my-2 ml-4 list-disc space-y-1">
                {frontend?.sharedFrontendId ? (
                  <li>
                    Routing rule and ACL for <strong>{frontend.hostname}</strong>{" "}
                    on shared frontend{" "}
                    <strong>{frontend.sharedFrontendName ?? "unknown"}</strong>
                  </li>
                ) : (
                  <li>
                    Dedicated HAProxy frontend{" "}
                    <strong>{frontend?.frontendName}</strong>
                  </li>
                )}
                <li>
                  HAProxy backend <strong>{frontend?.backendName}</strong> and
                  its server entries
                </li>
                {frontend?.useSSL && (
                  <li>TLS termination for this route (certificate file is kept)</li>
                )}
              </ul>
              <p>
                Traffic to <strong>{frontend?.hostname}</strong> will stop
                being routed. The container itself will not be stopped or
                removed.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isDeleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <IconTrash className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <IconTrash className="h-4 w-4 mr-2" />
                Delete
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
