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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IconChevronDown, IconLoader2, IconPlus } from "@tabler/icons-react";
import { ManagedDatabaseUserInfo } from "@mini-infra/types";

// Validation schema
const databaseSchema = z.object({
  databaseName: z
    .string()
    .min(1, "Database name is required")
    .regex(
      /^[a-z0-9_]+$/,
      "Only lowercase letters, numbers, and underscores allowed",
    ),
  owner: z.string().optional(),
  encoding: z.string().optional(),
  template: z.string().optional(),
  connectionLimit: z.number().optional(),
});

type DatabaseFormData = z.infer<typeof databaseSchema>;

interface DatabaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  availableUsers: ManagedDatabaseUserInfo[];
  onSubmit: (data: DatabaseFormData) => Promise<void>;
}

export function DatabaseModal({
  open,
  onOpenChange,
  availableUsers,
  onSubmit,
}: DatabaseModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    control,
    reset,
  } = useForm<DatabaseFormData>({
    resolver: zodResolver(databaseSchema),
    defaultValues: {
      databaseName: "",
      owner: undefined,
      encoding: "UTF8",
      template: "template0",
      connectionLimit: -1,
    },
  });

  const owner = useWatch({ control, name: "owner" });
  const encoding = useWatch({ control, name: "encoding" });
  const template = useWatch({ control, name: "template" });

  const handleFormSubmit = async (data: DatabaseFormData) => {
    setIsSubmitting(true);
    try {
      await onSubmit(data);
      reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create database:", error);
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
          <DialogTitle>Create Database</DialogTitle>
          <DialogDescription>
            Create a new database on this PostgreSQL server
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="space-y-4 py-4">
            {/* Database Name */}
            <div className="space-y-2">
              <Label htmlFor="databaseName">Database Name *</Label>
              <Input
                id="databaseName"
                placeholder="my_application_db"
                {...register("databaseName")}
              />
              {errors.databaseName && (
                <p className="text-sm text-destructive">
                  {errors.databaseName.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            {/* Owner */}
            <div className="space-y-2">
              <Label htmlFor="owner">Owner</Label>
              <Select
                value={owner}
                onValueChange={(value) => setValue("owner", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select owner user..." />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map((user) => (
                    <SelectItem key={user.id} value={user.username}>
                      {user.username}
                      {user.isSuperuser && " (superuser)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Optional: Assign a user as the database owner
              </p>
            </div>

            {/* Advanced Options (Collapsible) */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <span>Advanced Options</span>
                  <IconChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-4">
                {/* Encoding */}
                <div className="space-y-2">
                  <Label htmlFor="encoding">Encoding</Label>
                  <Select
                    value={encoding}
                    onValueChange={(value) => setValue("encoding", value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="UTF8">UTF8 (recommended)</SelectItem>
                      <SelectItem value="SQL_ASCII">SQL_ASCII</SelectItem>
                      <SelectItem value="LATIN1">LATIN1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Template */}
                <div className="space-y-2">
                  <Label htmlFor="template">Template</Label>
                  <Select
                    value={template}
                    onValueChange={(value) => setValue("template", value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="template0">
                        template0 (clean)
                      </SelectItem>
                      <SelectItem value="template1">
                        template1 (default)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    template0 is recommended for custom encoding
                  </p>
                </div>

                {/* Connection Limit */}
                <div className="space-y-2">
                  <Label htmlFor="connectionLimit">Connection Limit</Label>
                  <Input
                    id="connectionLimit"
                    type="number"
                    placeholder="-1 (unlimited)"
                    {...register("connectionLimit", { valueAsNumber: true })}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create Database
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
