import { useState } from "react";
import { Link } from "react-router-dom";
import {
  IconKey,
  IconPlus,
  IconArrowLeft,
  IconPencil,
  IconTrash,
  IconAlertCircle,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
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
import { toast } from "sonner";
import {
  usePermissionPresets,
  useCreatePermissionPreset,
  useUpdatePermissionPreset,
  useDeletePermissionPreset,
} from "@/hooks/use-permission-presets";
import { PresetFormDialog } from "@/components/api-keys/preset-form-dialog";
import type { PermissionPresetRecord } from "@mini-infra/types";

export function PermissionPresetsPage() {
  const { data: presets, isLoading, error } = usePermissionPresets();
  const createMutation = useCreatePermissionPreset();
  const updateMutation = useUpdatePermissionPreset();
  const deleteMutation = useDeletePermissionPreset();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PermissionPresetRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PermissionPresetRecord | null>(null);

  const handleCreate = async (data: {
    name: string;
    description: string;
    permissions: string[];
  }) => {
    try {
      await createMutation.mutateAsync(data);
      toast.success("Preset created successfully");
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create preset");
    }
  };

  const handleEdit = async (data: {
    name: string;
    description: string;
    permissions: string[];
  }) => {
    if (!editTarget) return;
    try {
      await updateMutation.mutateAsync({ id: editTarget.id, ...data });
      toast.success("Preset updated successfully");
      setEditTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update preset");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success("Preset deleted");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete preset");
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Link
                  to="/api-keys"
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <IconArrowLeft className="h-3 w-3" />
                  API Keys
                </Link>
              </div>
              <h1 className="text-3xl font-bold">Permission Presets</h1>
              <p className="text-muted-foreground">
                Manage reusable permission templates for API keys
              </p>
            </div>
          </div>

          <Button onClick={() => setCreateOpen(true)} className="flex items-center gap-2">
            <IconPlus className="h-4 w-4" />
            New Preset
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-4xl">
        {isLoading ? (
          <div className="grid gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-5 w-40" />
                    <div className="flex gap-2">
                      <Skeleton className="h-8 w-8" />
                      <Skeleton className="h-8 w-8" />
                    </div>
                  </div>
                  <Skeleton className="h-4 w-64" />
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <Skeleton key={j} className="h-5 w-24" />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load permission presets. {error.message}
            </AlertDescription>
          </Alert>
        ) : presets?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <IconKey className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-1">No presets yet</h3>
              <p className="text-muted-foreground mb-4">
                Create a preset to quickly apply permission sets when generating API keys.
              </p>
              <Button onClick={() => setCreateOpen(true)} className="flex items-center gap-2">
                <IconPlus className="h-4 w-4" />
                New Preset
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {presets?.map((preset) => (
              <Card key={preset.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">{preset.name}</CardTitle>
                      <Badge variant="secondary" className="text-xs">
                        {preset.permissions.includes("*")
                          ? "Full Access"
                          : `${preset.permissions.length} permission${preset.permissions.length !== 1 ? "s" : ""}`}
                      </Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditTarget(preset)}
                        title="Edit preset"
                      >
                        <IconPencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(preset)}
                        title="Delete preset"
                        className="text-destructive hover:text-destructive"
                      >
                        <IconTrash className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {preset.description && (
                    <CardDescription>{preset.description}</CardDescription>
                  )}
                </CardHeader>
                {!preset.permissions.includes("*") && preset.permissions.length > 0 && (
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {preset.permissions.map((scope) => (
                        <Badge key={scope} variant="outline" className="text-xs font-mono">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <PresetFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
        isPending={createMutation.isPending}
      />

      {/* Edit dialog */}
      <PresetFormDialog
        open={!!editTarget}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        preset={editTarget ?? undefined}
        onSubmit={handleEdit}
        isPending={updateMutation.isPending}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
              Existing API keys using this preset won't be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default PermissionPresetsPage;
