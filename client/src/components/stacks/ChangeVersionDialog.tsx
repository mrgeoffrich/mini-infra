import { useState } from "react";
import { IconArrowDown, IconArrowUp, IconCheck, IconLoader2 } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStackTemplateVersions } from "@/hooks/use-stack-templates";
import { useStackUpgradeFlow } from "@/hooks/use-stack-upgrade-flow";
import { UpgradeRotateGate } from "@/components/stacks/UpgradeRotateGate";
import type { StackInfo } from "@mini-infra/types";

/**
 * Move a stack to any published version of its template — forwards or backwards.
 *
 * Backwards matters more than it sounds. Template rollback only re-points the
 * template's `currentVersionId`; it does not touch installed stacks. So a stack
 * that had already adopted v4 stays on v4 while the template says v3 is current
 * — ahead of current, with no upgrade to take and, until now, no way back. This
 * dialog is that way back.
 */
export function ChangeVersionDialog({
  stack,
  label,
  open,
  onOpenChange,
}: {
  stack: StackInfo;
  /** Task-tracker label, e.g. `Changing version of ${app.name}`. */
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: versions, isLoading } = useStackTemplateVersions(
    open ? (stack.templateId ?? undefined) : undefined,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const flow = useStackUpgradeFlow({
    stackId: stack.id,
    label,
    onDone: () => {
      setSelectedId(null);
      onOpenChange(false);
    },
  });

  // Drafts are the author's unpublished work and archived versions are
  // deliberately retired; the server rejects both, so don't offer them.
  const publishable = (versions ?? [])
    .filter((v) => v.status === "published")
    .sort((a, b) => b.version - a.version);

  const installed = stack.templateVersion;
  const current = stack.templateCurrentVersion;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Change template version</DialogTitle>
            <DialogDescription>
              Deploy this stack from a different published version of its template.
              Choosing an older version rolls the stack back.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading versions…
            </div>
          ) : publishable.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              This template has no published versions.
            </p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto" data-tour="stack-version-picker">
              {publishable.map((v) => {
                const isInstalled = v.version === installed;
                const isCurrent = v.version === current;
                const isSelected = v.id === selectedId;
                const direction =
                  installed == null || v.version === installed
                    ? null
                    : v.version > installed
                      ? "upgrade"
                      : "downgrade";

                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      disabled={isInstalled}
                      onClick={() => setSelectedId(v.id)}
                      className={cn(
                        "w-full rounded-md border p-3 text-left transition-colors",
                        isSelected && "border-primary bg-primary/5",
                        isInstalled
                          ? "cursor-not-allowed opacity-60"
                          : "hover:border-primary/50 hover:bg-muted/50",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">v{v.version}</span>
                        {isInstalled && <Badge variant="secondary">Installed</Badge>}
                        {isCurrent && <Badge variant="outline">Template&apos;s current</Badge>}
                        {direction === "upgrade" && (
                          <IconArrowUp className="h-4 w-4 text-blue-600" aria-label="Upgrade" />
                        )}
                        {direction === "downgrade" && (
                          <IconArrowDown
                            className="h-4 w-4 text-amber-600"
                            aria-label="Downgrade"
                          />
                        )}
                        {isSelected && <IconCheck className="ml-auto h-4 w-4 text-primary" />}
                      </div>
                      {v.notes && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {v.notes}
                        </p>
                      )}
                      {v.publishedAt && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Published {new Date(v.publishedAt).toLocaleDateString()}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={flow.busy}>
              Cancel
            </Button>
            <Button
              disabled={!selectedId || flow.busy}
              onClick={() => selectedId && void flow.start(selectedId)}
            >
              {flow.busy && <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />}
              Deploy this version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UpgradeRotateGate flow={flow} />
    </>
  );
}
