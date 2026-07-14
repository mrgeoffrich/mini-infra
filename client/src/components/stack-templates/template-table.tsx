import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { IconDotsVertical } from "@tabler/icons-react";
import type { StackTemplateInfo, StackTemplateLinkedStack } from "@mini-infra/types";
import {
  useDeleteTemplate,
  useUpdateStackTemplate,
} from "@/hooks/use-stack-templates";
import { toast } from "sonner";

interface TemplateTableProps {
  templates: StackTemplateInfo[];
}

function getStatusBadge(template: StackTemplateInfo) {
  if (template.isArchived) {
    return <Badge variant="outline">Archived</Badge>;
  }
  if (template.currentVersionId && template.draftVersionId) {
    return (
      <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300 border-0">
        Has Draft
      </Badge>
    );
  }
  if (template.currentVersionId) {
    return (
      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300 border-0">
        Published
      </Badge>
    );
  }
  return <Badge variant="secondary">Draft Only</Badge>;
}

function getVersionDisplay(template: StackTemplateInfo): string {
  if (template.currentVersion) {
    return `v${template.currentVersion.version}`;
  }
  return "—";
}

/**
 * A linked stack blocks template deletion when it's still deployed. The server
 * rejects the delete unless every linked stack is `undeployed` or already
 * removed (see stack-template-service.deleteTemplate).
 */
function isDeployed(stack: StackTemplateLinkedStack): boolean {
  return stack.status !== "undeployed" && stack.status !== "removed";
}

export function TemplateTable({ templates }: TemplateTableProps) {
  const navigate = useNavigate();
  const deleteMutation = useDeleteTemplate();
  const updateMutation = useUpdateStackTemplate();
  const [deleteTarget, setDeleteTarget] = useState<StackTemplateInfo | null>(null);

  function handleRowClick(template: StackTemplateInfo) {
    navigate(`/stack-templates/${template.id}`);
  }

  function handleEdit(e: React.MouseEvent, template: StackTemplateInfo) {
    e.stopPropagation();
    navigate(`/stack-templates/${template.id}`);
  }

  async function handleArchiveToggle(e: React.MouseEvent, template: StackTemplateInfo) {
    e.stopPropagation();
    const nextArchived = !template.isArchived;
    try {
      await updateMutation.mutateAsync({
        templateId: template.id,
        request: { isArchived: nextArchived },
      });
      toast.success(
        nextArchived
          ? `Template "${template.displayName}" archived`
          : `Template "${template.displayName}" unarchived`,
      );
    } catch {
      // Swallow: the global MutationCache.onError already toasts the real error.
    }
  }

  function handleDeleteClick(e: React.MouseEvent, template: StackTemplateInfo) {
    e.stopPropagation();
    setDeleteTarget(template);
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success(`Template "${deleteTarget.displayName}" deleted`);
    } catch {
      // Swallow: the global MutationCache.onError already toasts the real error.
    } finally {
      setDeleteTarget(null);
    }
  }

  const linkedStacks = deleteTarget?.linkedStacks ?? [];
  const blockingStacks = linkedStacks.filter(isDeployed);
  const deletableStacks = linkedStacks.filter((s) => !isDeployed(s));
  const deleteBlocked = blockingStacks.length > 0;

  if (templates.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        No templates found
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Template</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((template) => (
            <TableRow
              key={template.id}
              className="cursor-pointer"
              onClick={() => handleRowClick(template)}
            >
              <TableCell>
                <div>
                  <p className="font-medium">{template.displayName}</p>
                  {template.description && (
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {template.description}
                    </p>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="capitalize">
                  {template.source}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {template.scope}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {getVersionDisplay(template)}
              </TableCell>
              <TableCell>{getStatusBadge(template)}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconDotsVertical className="h-4 w-4" />
                      <span className="sr-only">Open menu</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={(e) => handleEdit(e, template)}
                    >
                      Edit
                    </DropdownMenuItem>
                    {template.source !== "system" && (
                      <>
                        <DropdownMenuItem
                          onClick={(e) => handleArchiveToggle(e, template)}
                        >
                          {template.isArchived ? "Unarchive" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={(e) => handleDeleteClick(e, template)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Permanently delete{" "}
                  <span className="font-medium">{deleteTarget?.displayName}</span>?
                  This can&apos;t be undone. To simply hide it from the list,
                  use Archive instead.
                </p>
                {linkedStacks.length === 0 ? (
                  <p>This template has no linked stacks.</p>
                ) : deleteBlocked ? (
                  <div className="space-y-1">
                    <p className="text-destructive font-medium">
                      Deployed stacks block deletion. Stop or remove these
                      first:
                    </p>
                    <ul className="list-disc pl-5">
                      {blockingStacks.map((s) => (
                        <li key={s.id}>
                          {s.name} ({s.status})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p>
                      {deletableStacks.length} linked stack
                      {deletableStacks.length === 1 ? "" : "s"} (not deployed)
                      will also be deleted:
                    </p>
                    <ul className="list-disc pl-5">
                      {deletableStacks.map((s) => (
                        <li key={s.id}>
                          {s.name} ({s.status})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deleteBlocked || deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
