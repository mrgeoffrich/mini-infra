import { useState } from "react";
import {
  IconBan,
  IconEye,
  IconEdit,
  IconShield,
  IconDatabase,
  IconFolders,
  IconTable,
  IconCheck,
  IconTrash,
  IconAlertCircle,
  IconLoader2,
  IconUser,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Separator } from "../ui/separator";
import { Alert, AlertDescription } from "../ui/alert";
import {
  useCreateDatabaseGrant,
  useUpdateDatabaseGrant,
  useDeleteDatabaseGrant,
} from "../../hooks/use-database-grants";
import type { DatabaseGrantInfo, ManagedDatabaseInfo, ManagedDatabaseUserInfo } from "@mini-infra/types";

// Permission preset configurations
const PERMISSION_PRESETS = {
  none: {
    canConnect: false,
    canCreate: false,
    canTemp: false,
    canCreateSchema: false,
    canUsageSchema: false,
    canSelect: false,
    canInsert: false,
    canUpdate: false,
    canDelete: false,
  },
  readonly: {
    canConnect: true,
    canCreate: false,
    canTemp: false,
    canCreateSchema: false,
    canUsageSchema: true,
    canSelect: true,
    canInsert: false,
    canUpdate: false,
    canDelete: false,
  },
  readwrite: {
    canConnect: true,
    canCreate: false,
    canTemp: true,
    canCreateSchema: false,
    canUsageSchema: true,
    canSelect: true,
    canInsert: true,
    canUpdate: true,
    canDelete: true,
  },
  full: {
    canConnect: true,
    canCreate: true,
    canTemp: true,
    canCreateSchema: true,
    canUsageSchema: true,
    canSelect: true,
    canInsert: true,
    canUpdate: true,
    canDelete: true,
  },
} as const;

type PermissionPreset = keyof typeof PERMISSION_PRESETS;

interface Permissions {
  canConnect: boolean;
  canCreate: boolean;
  canTemp: boolean;
  canCreateSchema: boolean;
  canUsageSchema: boolean;
  canSelect: boolean;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

interface GrantEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  database: ManagedDatabaseInfo;
  user: ManagedDatabaseUserInfo;
  existingGrant?: DatabaseGrantInfo;
}

function grantToPermissions(existingGrant: DatabaseGrantInfo): Permissions {
  return {
    canConnect: existingGrant.canConnect,
    canCreate: existingGrant.canCreate,
    canTemp: existingGrant.canTemp,
    canCreateSchema: existingGrant.canCreateSchema,
    canUsageSchema: existingGrant.canUsageSchema,
    canSelect: existingGrant.canSelect,
    canInsert: existingGrant.canInsert,
    canUpdate: existingGrant.canUpdate,
    canDelete: existingGrant.canDelete,
  };
}

function detectPresetFor(perms: Permissions): PermissionPreset | null {
  for (const [presetName, presetPerms] of Object.entries(PERMISSION_PRESETS)) {
    if (JSON.stringify(perms) === JSON.stringify(presetPerms)) {
      return presetName as PermissionPreset;
    }
  }
  return null;
}

export function GrantEditor(props: GrantEditorProps) {
  // Re-mount the inner editor each time the dialog is opened so form state
  // is re-initialized from props instead of synced via useEffect.
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <GrantEditorInner {...props} />}
    </Dialog>
  );
}

function GrantEditorInner({
  onOpenChange,
  serverId,
  database,
  user,
  existingGrant,
}: GrantEditorProps) {
  const [permissions, setPermissions] = useState<Permissions>(() =>
    existingGrant
      ? grantToPermissions(existingGrant)
      : PERMISSION_PRESETS.readwrite,
  );
  const [currentPreset, setCurrentPreset] = useState<PermissionPreset | null>(
    () =>
      existingGrant
        ? detectPresetFor(grantToPermissions(existingGrant))
        : "readwrite",
  );

  const createMutation = useCreateDatabaseGrant(serverId);
  const updateMutation = useUpdateDatabaseGrant();
  const deleteMutation = useDeleteDatabaseGrant(serverId);

  const isSubmitting =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  // Detect which preset matches current permissions
  const detectPreset = (perms: Permissions) => {
    setCurrentPreset(detectPresetFor(perms));
  };

  // Apply a preset
  const applyPreset = (preset: PermissionPreset) => {
    setPermissions(PERMISSION_PRESETS[preset]);
    setCurrentPreset(preset);
  };

  // Update individual permission and clear preset if it no longer matches
  const updatePermission = (key: keyof Permissions, value: boolean) => {
    const newPermissions = { ...permissions, [key]: value };
    setPermissions(newPermissions);
    detectPreset(newPermissions);
  };

  // Handle save
  const handleSave = async () => {
    try {
      if (existingGrant) {
        // Update existing grant
        await updateMutation.mutateAsync({
          grantId: existingGrant.id,
          updates: permissions,
        });
        toast.success("Permissions updated successfully");
      } else {
        // Create new grant
        await createMutation.mutateAsync({
          serverId,
          databaseId: database.id,
          managedUserId: user.id,
          ...permissions,
        });
        toast.success("Grant created successfully");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save permissions");
    }
  };

  // Handle revoke all
  const handleRevokeAll = async () => {
    if (!existingGrant) return;

    try {
      await deleteMutation.mutateAsync(existingGrant.id);
      toast.success("All permissions revoked");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to revoke permissions");
    }
  };

  const isOwner = user.username === database.owner;

  return (
    <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Manage Database Permissions</DialogTitle>
          <div className="space-y-3 pt-2">
            {/* User Info */}
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border">
              <IconUser className="h-5 w-5 text-blue-600" />
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold font-mono">{user.username}</span>
                  {isOwner && (
                    <Badge variant="outline" className="text-xs border-purple-500 text-purple-700 dark:text-purple-300">
                      Database Owner
                    </Badge>
                  )}
                  {user.isSuperuser && (
                    <Badge variant="destructive" className="text-xs">
                      Superuser
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            {/* Database Info */}
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border">
              <IconDatabase className="h-5 w-5 text-purple-600" />
              <div className="flex-1">
                <span className="font-semibold font-mono">{database.databaseName}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Quick Presets */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Permission Presets</Label>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant={currentPreset === "none" ? "default" : "outline"}
                onClick={() => applyPreset("none")}
                className="justify-start p-3"
                disabled={isSubmitting}
              >
                <IconBan className="h-5 w-5 mr-2" />
                <span className="font-semibold">No Access</span>
              </Button>
              <Button
                type="button"
                variant={currentPreset === "readonly" ? "default" : "outline"}
                onClick={() => applyPreset("readonly")}
                className="justify-start p-3"
                disabled={isSubmitting}
              >
                <IconEye className="h-5 w-5 mr-2" />
                <span className="font-semibold">Read Only</span>
              </Button>
              <Button
                type="button"
                variant={currentPreset === "readwrite" ? "default" : "outline"}
                onClick={() => applyPreset("readwrite")}
                className="justify-start p-3"
                disabled={isSubmitting}
              >
                <IconEdit className="h-5 w-5 mr-2" />
                <span className="font-semibold">Read/Write</span>
              </Button>
              <Button
                type="button"
                variant={currentPreset === "full" ? "default" : "outline"}
                onClick={() => applyPreset("full")}
                className="justify-start p-3"
                disabled={isSubmitting}
              >
                <IconShield className="h-5 w-5 mr-2" />
                <span className="font-semibold">Full Access</span>
              </Button>
            </div>
          </div>

          <Separator />

          {/* Database-Level Privileges */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <IconDatabase className="h-5 w-5 text-purple-600" />
              <h4 className="font-semibold">Database Privileges</h4>
            </div>

            <div className="space-y-2 pl-7">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canConnect" className="font-normal">
                    CONNECT
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Allow connection to this database
                  </p>
                </div>
                <Switch
                  id="canConnect"
                  checked={permissions.canConnect}
                  onCheckedChange={(checked) => updatePermission("canConnect", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canCreate" className="font-normal">
                    CREATE
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Create new schemas in the database
                  </p>
                </div>
                <Switch
                  id="canCreate"
                  checked={permissions.canCreate}
                  onCheckedChange={(checked) => updatePermission("canCreate", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canTemp" className="font-normal">
                    TEMP
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Create temporary tables
                  </p>
                </div>
                <Switch
                  id="canTemp"
                  checked={permissions.canTemp}
                  onCheckedChange={(checked) => updatePermission("canTemp", checked)}
                  disabled={isSubmitting}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Schema-Level Privileges */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <IconFolders className="h-5 w-5 text-blue-600" />
              <h4 className="font-semibold">Schema Privileges (public schema)</h4>
            </div>

            <div className="space-y-2 pl-7">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canUsageSchema" className="font-normal">
                    USAGE
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Access objects in the schema
                  </p>
                </div>
                <Switch
                  id="canUsageSchema"
                  checked={permissions.canUsageSchema}
                  onCheckedChange={(checked) => updatePermission("canUsageSchema", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canCreateSchema" className="font-normal">
                    CREATE
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Create objects in the schema
                  </p>
                </div>
                <Switch
                  id="canCreateSchema"
                  checked={permissions.canCreateSchema}
                  onCheckedChange={(checked) => updatePermission("canCreateSchema", checked)}
                  disabled={isSubmitting}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Table-Level Privileges */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <IconTable className="h-5 w-5 text-green-600" />
              <h4 className="font-semibold">Table Privileges (all tables)</h4>
            </div>

            <div className="grid grid-cols-2 gap-3 pl-7">
              <div className="flex items-center justify-between">
                <Label htmlFor="canSelect" className="font-normal">
                  SELECT
                </Label>
                <Switch
                  id="canSelect"
                  checked={permissions.canSelect}
                  onCheckedChange={(checked) => updatePermission("canSelect", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="canInsert" className="font-normal">
                  INSERT
                </Label>
                <Switch
                  id="canInsert"
                  checked={permissions.canInsert}
                  onCheckedChange={(checked) => updatePermission("canInsert", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="canUpdate" className="font-normal">
                  UPDATE
                </Label>
                <Switch
                  id="canUpdate"
                  checked={permissions.canUpdate}
                  onCheckedChange={(checked) => updatePermission("canUpdate", checked)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="canDelete" className="font-normal">
                  DELETE
                </Label>
                <Switch
                  id="canDelete"
                  checked={permissions.canDelete}
                  onCheckedChange={(checked) => updatePermission("canDelete", checked)}
                  disabled={isSubmitting}
                />
              </div>
            </div>
          </div>

          {/* Warning for No Access */}
          {!permissions.canConnect && (
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                User will not be able to connect to this database. All other permissions require
                CONNECT privilege.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          {existingGrant && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleRevokeAll}
              disabled={isSubmitting}
            >
              <IconTrash className="h-4 w-4 mr-2" />
              Revoke All
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <IconCheck className="h-4 w-4 mr-2" />
                Save Permissions
              </>
            )}
          </Button>
        </DialogFooter>
    </DialogContent>
  );
}
