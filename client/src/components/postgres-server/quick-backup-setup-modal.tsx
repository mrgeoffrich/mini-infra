import { useState, useEffect } from "react";
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
import { IconLoader2, IconRocket } from "@tabler/icons-react";
import { ManagedDatabaseInfo } from "@mini-infra/types";
import { useQuickSetupPostgresBackup } from "@/hooks/use-postgres-backup-configs";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { useSystemSettings } from "@/hooks/use-settings";
import { toast } from "sonner";

// Validation schema
const quickBackupSetupSchema = z.object({
  databaseName: z.string().min(1, "Database selection is required"),
});

type QuickBackupSetupFormData = z.infer<typeof quickBackupSetupSchema>;

interface QuickBackupSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverName: string;
  availableDatabases: ManagedDatabaseInfo[];
  preSelectedDatabase?: string; // Optional pre-selected database name
}

export function QuickBackupSetupModal({
  open,
  onOpenChange,
  serverId,
  serverName,
  availableDatabases,
  preSelectedDatabase,
}: QuickBackupSetupModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const quickSetupMutation = useQuickSetupPostgresBackup();
  const { data: userPreferences } = useUserPreferences();

  // Fetch default container setting
  const { data: defaultContainerData } = useSystemSettings({
    filters: {
      category: "system",
      key: "default_postgres_backup_container",
      isActive: true,
    },
    limit: 1,
  });

  const {
    handleSubmit,
    formState: { errors },
    setValue,
    control,
    reset,
  } = useForm<QuickBackupSetupFormData>({
    resolver: zodResolver(quickBackupSetupSchema),
    defaultValues: {
      databaseName: preSelectedDatabase || "",
    },
  });

  const selectedDatabaseName = useWatch({ control, name: "databaseName" });
  const timezone = userPreferences?.timezone || "UTC";
  const defaultContainer =
    defaultContainerData?.data?.[0]?.value || "postgres-backups";

  // Update form when pre-selected database changes or modal opens
  useEffect(() => {
    if (open && preSelectedDatabase) {
      setValue("databaseName", preSelectedDatabase);
    }
  }, [open, preSelectedDatabase, setValue]);

  const handleFormSubmit = async (data: QuickBackupSetupFormData) => {
    setIsSubmitting(true);
    try {
      await quickSetupMutation.mutateAsync({
        serverId,
        databaseName: data.databaseName,
      });

      toast.success("Backup configured successfully", {
        description: `Daily backups scheduled for ${data.databaseName} at 2:00 AM ${timezone}`,
      });

      reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to setup backup:", error);
      toast.error("Failed to setup backup", {
        description: error instanceof Error ? error.message : "An unknown error occurred",
      });
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Quick Backup Setup</DialogTitle>
          <DialogDescription>
            Quickly configure daily backups for a database on {serverName}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="space-y-4 py-4">
            {/* Database Selection */}
            <div className="space-y-2">
              <Label htmlFor="databaseName">Select Database *</Label>
              <Select
                value={selectedDatabaseName}
                onValueChange={(value) => setValue("databaseName", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a database to backup..." />
                </SelectTrigger>
                <SelectContent>
                  {availableDatabases.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      No databases available
                    </div>
                  ) : (
                    availableDatabases.map((database) => (
                      <SelectItem
                        key={database.id}
                        value={database.databaseName}
                      >
                        {database.databaseName}
                        {database.owner && ` (owner: ${database.owner})`}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {errors.databaseName && (
                <p className="text-sm text-destructive">
                  {errors.databaseName.message}
                </p>
              )}
            </div>

            {/* Configuration Preview */}
            <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
              <h4 className="text-sm font-medium">Backup Configuration</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Schedule:</span>
                  <span className="font-medium">Daily at 2:00 AM</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Timezone:</span>
                  <span className="font-medium">{timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status:</span>
                  <span className="font-medium text-green-600">Enabled</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Storage:</span>
                  <span className="font-medium">Azure ({defaultContainer})</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Retention:</span>
                  <span className="font-medium">30 days</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Format:</span>
                  <span className="font-medium">Custom (compressed)</span>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Backups will be automatically created daily and stored in Azure Blob Storage.
              You can modify these settings later if needed.
            </p>
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
              disabled={isSubmitting || !selectedDatabaseName}
            >
              {isSubmitting ? (
                <>
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  Setting up...
                </>
              ) : (
                <>
                  <IconRocket className="mr-2 h-4 w-4" />
                  Setup Backup
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
