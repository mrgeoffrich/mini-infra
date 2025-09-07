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
import { useDeletePostgresDatabase } from "@/hooks/use-postgres-databases";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { PostgresDatabaseInfo } from "@mini-infra/types";

interface DeleteDatabaseDialogProps {
  database: PostgresDatabaseInfo | null;
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteDatabaseDialog({
  database,
  isOpen,
  onClose,
}: DeleteDatabaseDialogProps) {
  const deleteMutation = useDeletePostgresDatabase();

  const confirmDelete = async () => {
    if (!database) return;

    try {
      await deleteMutation.mutateAsync(database.id);
      toast.success("Database deleted successfully");
      onClose();
    } catch (error) {
      toast.error(
        `Failed to delete database: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the database configuration for "
            {database?.name}". This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDelete}
            disabled={deleteMutation.isPending}
            className="bg-red-600 hover:bg-red-700"
          >
            {deleteMutation.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}