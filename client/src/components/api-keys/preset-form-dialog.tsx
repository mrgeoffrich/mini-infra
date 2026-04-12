import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { IconLoader2 } from "@tabler/icons-react";
import { PERMISSION_GROUPS } from "@mini-infra/types";
import type { PermissionPresetRecord, PermissionScope } from "@mini-infra/types";

interface PresetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: PermissionPresetRecord;
  onSubmit: (data: {
    name: string;
    description: string;
    permissions: PermissionScope[];
  }) => Promise<void>;
  isPending?: boolean;
}

export function PresetFormDialog({
  open,
  onOpenChange,
  preset,
  onSubmit,
  isPending = false,
}: PresetFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Key by open+preset id so the form state resets when the dialog
          re-opens or the target preset changes, instead of syncing in an effect. */}
      <PresetFormDialogContent
        key={open ? `${preset?.id ?? "new"}-open` : "closed"}
        preset={preset}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isPending={isPending}
      />
    </Dialog>
  );
}

function PresetFormDialogContent({
  preset,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  preset?: PermissionPresetRecord;
  onOpenChange: (open: boolean) => void;
  onSubmit: PresetFormDialogProps["onSubmit"];
  isPending: boolean;
}) {
  const isEdit = !!preset;

  const [name, setName] = useState(preset?.name ?? "");
  const [description, setDescription] = useState(preset?.description ?? "");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<PermissionScope>>(
    () => new Set(preset?.permissions ?? []),
  );
  const [nameError, setNameError] = useState("");

  const togglePermission = (scope: PermissionScope) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const toggleDomainAll = (domain: string) => {
    const group = PERMISSION_GROUPS.find((g) => g.domain === domain);
    if (!group) return;

    const domainScopes = group.permissions.map((p) => p.scope);
    const allSelected = domainScopes.every((s) => selectedPermissions.has(s));

    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        domainScopes.forEach((s) => next.delete(s));
      } else {
        domainScopes.forEach((s) => next.add(s));
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setNameError("Name is required");
      return;
    }
    if (name.length > 100) {
      setNameError("Name must be less than 100 characters");
      return;
    }
    setNameError("");

    await onSubmit({
      name: name.trim(),
      description: description.trim(),
      permissions: Array.from(selectedPermissions),
    });
  };

  const permissionCount = selectedPermissions.has("*")
    ? "All"
    : selectedPermissions.size.toString();

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Preset" : "New Preset"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the name, description, or permissions for this preset."
              : "Create a new permission preset template."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Read-Only Ops"
              disabled={isPending}
            />
            {nameError && <p className="text-sm text-destructive">{nameError}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="preset-description">Description</Label>
            <Textarea
              id="preset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description for this preset"
              rows={2}
              disabled={isPending}
            />
          </div>

          {/* Permissions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Permissions</Label>
              <span className="text-sm text-muted-foreground">
                {permissionCount} selected
              </span>
            </div>
            <Accordion type="multiple" className="w-full">
              {PERMISSION_GROUPS.map((group) => {
                const domainScopes = group.permissions.map((p) => p.scope);
                const allSelected =
                  !selectedPermissions.has("*") &&
                  domainScopes.every((s) => selectedPermissions.has(s));
                const someSelected =
                  selectedPermissions.has("*") ||
                  domainScopes.some((s) => selectedPermissions.has(s));

                return (
                  <AccordionItem key={group.domain} value={group.domain}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{group.label}</span>
                        {someSelected && (
                          <Badge
                            variant={
                              allSelected || selectedPermissions.has("*")
                                ? "default"
                                : "secondary"
                            }
                            className="text-xs"
                          >
                            {selectedPermissions.has("*")
                              ? "All"
                              : allSelected
                                ? "All"
                                : `${domainScopes.filter((s) => selectedPermissions.has(s)).length}/${domainScopes.length}`}
                          </Badge>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3 pt-1">
                        <p className="text-sm text-muted-foreground">{group.description}</p>
                        <div className="flex items-center space-x-2 pb-1">
                          <Checkbox
                            id={`preset-${group.domain}-all`}
                            checked={selectedPermissions.has("*") || allSelected}
                            disabled={selectedPermissions.has("*") || isPending}
                            onCheckedChange={() => toggleDomainAll(group.domain)}
                          />
                          <label
                            htmlFor={`preset-${group.domain}-all`}
                            className="text-sm font-medium cursor-pointer"
                          >
                            Select all
                          </label>
                        </div>
                        {group.permissions.map((perm) => (
                          <div key={perm.scope} className="flex items-start space-x-2 ml-4">
                            <Checkbox
                              id={`preset-${perm.scope}`}
                              checked={
                                selectedPermissions.has("*") ||
                                selectedPermissions.has(perm.scope)
                              }
                              disabled={selectedPermissions.has("*") || isPending}
                              onCheckedChange={() => togglePermission(perm.scope)}
                            />
                            <div className="grid gap-0.5 leading-none">
                              <label
                                htmlFor={`preset-${perm.scope}`}
                                className="text-sm font-medium cursor-pointer"
                              >
                                {perm.label}
                              </label>
                              <p className="text-xs text-muted-foreground">{perm.description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 animate-spin mr-2" />
                  {isEdit ? "Saving..." : "Creating..."}
                </>
              ) : isEdit ? (
                "Save Changes"
              ) : (
                "Create Preset"
              )}
            </Button>
          </DialogFooter>
        </form>
    </DialogContent>
  );
}
