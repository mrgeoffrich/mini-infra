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
import type { StackTemplateInfo } from "@mini-infra/types";
import { useArchiveTemplate } from "@/hooks/use-stack-templates";
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

export function TemplateTable({ templates }: TemplateTableProps) {
  const navigate = useNavigate();
  const archiveMutation = useArchiveTemplate();
  const [archiveTarget, setArchiveTarget] = useState<StackTemplateInfo | null>(null);

  function handleRowClick(template: StackTemplateInfo) {
    navigate(`/stack-templates/${template.id}`);
  }

  function handleEdit(e: React.MouseEvent, template: StackTemplateInfo) {
    e.stopPropagation();
    navigate(`/stack-templates/${template.id}`);
  }

  function handleArchiveClick(e: React.MouseEvent, template: StackTemplateInfo) {
    e.stopPropagation();
    setArchiveTarget(template);
  }

  async function handleArchiveConfirm() {
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync(archiveTarget.id);
      toast.success(`Template "${archiveTarget.displayName}" archived`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to archive template",
      );
    } finally {
      setArchiveTarget(null);
    }
  }

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
                    {!template.isArchived && (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(e) => handleArchiveClick(e, template)}
                      >
                        Archive
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog
        open={!!archiveTarget}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to archive{" "}
              <span className="font-medium">{archiveTarget?.displayName}</span>?
              Archived templates will no longer appear in the default list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveConfirm}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
