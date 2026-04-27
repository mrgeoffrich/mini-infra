import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconLoader2, IconUserEdit } from "@tabler/icons-react";
import { ManagedDatabaseInfo, ManagedDatabaseUserInfo } from "@mini-infra/types";

// Validation schema
const changeOwnerSchema = z.object({
  newOwner: z.string().min(1, "Please select a new owner"),
});

type ChangeOwnerFormData = z.infer<typeof changeOwnerSchema>;

interface ChangeOwnerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  database: ManagedDatabaseInfo;
  availableUsers: ManagedDatabaseUserInfo[];
  onSubmit: (data: ChangeOwnerFormData) => Promise<void>;
}

export function ChangeOwnerModal({
  open,
  onOpenChange,
  database,
  availableUsers,
  onSubmit,
}: ChangeOwnerModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    handleSubmit,
    formState: { errors },
    setValue,
    control,
    reset,
  } = useForm<ChangeOwnerFormData>({
    resolver: zodResolver(changeOwnerSchema),
    defaultValues: {
      newOwner: "",
    },
  });

  const newOwner = useWatch({ control, name: "newOwner" });

  // Filter out the current owner from the available users
  const selectableUsers = availableUsers.filter(
    (user) => user.username !== database.owner
  );

  const handleFormSubmit = async (data: ChangeOwnerFormData) => {
    setIsSubmitting(true);
    try {
      await onSubmit(data);
      reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to change database owner:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isSubmitting) {
      reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change Database Owner</DialogTitle>
          <DialogDescription>
            Change the owner of the database "{database.databaseName}"
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="space-y-4 py-4">
            {/* Current Database Info */}
            <div className="rounded-lg bg-muted p-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Database:</span>
                <span className="font-medium">{database.databaseName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Current Owner:</span>
                <span className="font-medium">{database.owner}</span>
              </div>
            </div>

            {/* New Owner Selection */}
            <div className="space-y-2">
              <Label htmlFor="newOwner">New Owner *</Label>
              <Select
                value={newOwner}
                onValueChange={(value) => setValue("newOwner", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select new owner..." />
                </SelectTrigger>
                <SelectContent>
                  {selectableUsers.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      No other users available
                    </div>
                  ) : (
                    selectableUsers.map((user) => (
                      <SelectItem key={user.id} value={user.username}>
                        {user.username}
                        {user.isSuperuser && " (superuser)"}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {errors.newOwner && (
                <p className="text-sm text-destructive">
                  {errors.newOwner.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Select a user to transfer ownership of this database
              </p>
            </div>

            {/* Warning about ownership */}
            <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 p-3">
              <p className="text-xs text-yellow-800 dark:text-yellow-200">
                <strong>Note:</strong> Changing the database owner may affect
                existing permissions and object ownership within the database.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || selectableUsers.length === 0}
            >
              {isSubmitting ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Changing Owner...
                </>
              ) : (
                <>
                  <IconUserEdit className="h-4 w-4 mr-2" />
                  Change Owner
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
