import { useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { toast } from "sonner";
import { IconArrowBackUp, IconExternalLink, IconLoader2 } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { StackStatusBadge } from "@/components/stacks/StackStatusBadge";
import { useRollbackTemplateVersion } from "@/hooks/use-stack-templates";
import type { StackTemplateInfo, StackTemplateVersionInfo } from "@mini-infra/types";

interface VersionSidebarProps {
  template: StackTemplateInfo;
  versions: StackTemplateVersionInfo[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  /** Show "Make current" rollback controls. False for system templates. */
  canManageVersions?: boolean;
}

export function VersionSidebar({
  template,
  versions,
  selectedVersionId,
  onSelectVersion,
  canManageVersions = false,
}: VersionSidebarProps) {
  const rollback = useRollbackTemplateVersion();
  const [rollbackTarget, setRollbackTarget] = useState<StackTemplateVersionInfo | null>(null);

  const draftVersion = versions.find((v) => v.status === "draft");
  const publishedVersions = versions
    .filter((v) => v.status === "published")
    .sort((a, b) => b.version - a.version);
  const archivedVersions = versions
    .filter((v) => v.status === "archived")
    .sort((a, b) => b.version - a.version);

  // null selectedVersionId means the draft is selected
  const isDraftSelected = selectedVersionId === null;

  const linkedStacks = template.linkedStacks ?? [];

  async function handleMakeCurrent(version: StackTemplateVersionInfo) {
    try {
      await rollback.mutateAsync({ templateId: template.id, versionId: version.id });
      toast.success(`v${version.version} is now the current version`);
    } catch {
      // Global MutationCache.onError toasts the actionable error.
    } finally {
      setRollbackTarget(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Version History
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="px-2 pb-4 space-y-1">
          {/* Draft entry */}
          {draftVersion && (
            <button
              onClick={() => onSelectVersion(null)}
              className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent ${
                isDraftSelected
                  ? "border-orange-500 bg-orange-50 dark:bg-orange-950/20"
                  : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium">Draft</span>
                <Badge className="bg-orange-500 text-white text-xs">editing</Badge>
              </div>
              {draftVersion.createdAt && (
                <div className="text-xs text-muted-foreground">
                  Modified {format(new Date(draftVersion.createdAt), "MMM d, yyyy")}
                </div>
              )}
            </button>
          )}

          {/* Published versions */}
          {publishedVersions.map((version) => {
            const isCurrent = version.id === template.currentVersionId;
            const isSelected = selectedVersionId === version.id;
            return (
              <div
                key={version.id}
                className={`rounded-md border transition-colors ${
                  isSelected
                    ? isCurrent
                      ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                      : "border-primary bg-accent"
                    : isCurrent
                      ? "border-green-500/50"
                      : "border-border"
                }`}
              >
                <button
                  onClick={() => onSelectVersion(version.id)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium">v{version.version}</span>
                    {isCurrent ? (
                      <Badge className="bg-green-500 text-white text-xs">current</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        published
                      </Badge>
                    )}
                  </div>
                  {version.notes && (
                    <div className="text-xs text-muted-foreground truncate">{version.notes}</div>
                  )}
                  {version.publishedAt && (
                    <div className="text-xs text-muted-foreground">
                      Published {format(new Date(version.publishedAt), "MMM d, yyyy")}
                    </div>
                  )}
                </button>
                {canManageVersions && !isCurrent && (
                  <div className="px-2 pb-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full justify-start text-xs"
                      disabled={rollback.isPending}
                      onClick={() => setRollbackTarget(version)}
                    >
                      <IconArrowBackUp className="h-3.5 w-3.5 mr-1" />
                      Make current
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Archived versions */}
          {archivedVersions.length > 0 && (
            <details>
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground hover:text-foreground select-none">
                {archivedVersions.length} archived version
                {archivedVersions.length !== 1 ? "s" : ""}
              </summary>
              <div className="space-y-1 mt-1">
                {archivedVersions.map((version) => {
                  const isSelected = selectedVersionId === version.id;
                  return (
                    <button
                      key={version.id}
                      onClick={() => onSelectVersion(version.id)}
                      className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent ${
                        isSelected ? "border-primary bg-accent" : "border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium">v{version.version}</span>
                        <Badge variant="outline" className="text-xs">
                          archived
                        </Badge>
                      </div>
                      {version.notes && (
                        <div className="text-xs text-muted-foreground truncate">
                          {version.notes}
                        </div>
                      )}
                      {version.publishedAt && (
                        <div className="text-xs text-muted-foreground">
                          Published {format(new Date(version.publishedAt), "MMM d, yyyy")}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </details>
          )}
        </div>

        {/* Used by N stacks */}
        <div className="border-t px-3 py-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Used by {linkedStacks.length} stack{linkedStacks.length !== 1 ? "s" : ""}
          </div>
          {linkedStacks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No stacks installed from this template.</p>
          ) : (
            <ul className="space-y-1">
              {linkedStacks.map((stack) => (
                <li key={stack.id}>
                  <Link
                    to={`/stacks/${stack.id}`}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
                  >
                    <span className="inline-flex items-center gap-1 truncate">
                      <IconExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{stack.name}</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      {stack.templateVersion != null && (
                        <span className="text-xs text-muted-foreground">v{stack.templateVersion}</span>
                      )}
                      <StackStatusBadge status={stack.status} showTooltip={false} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make v{rollbackTarget?.version} current?</AlertDialogTitle>
            <AlertDialogDescription>
              New installs will use v{rollbackTarget?.version}, and installed stacks
              will compare against it for the update badge. Existing stacks aren&apos;t
              changed until you upgrade them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollback.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              onClick={() => rollbackTarget && handleMakeCurrent(rollbackTarget)}
            >
              {rollback.isPending && <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />}
              Make current
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
