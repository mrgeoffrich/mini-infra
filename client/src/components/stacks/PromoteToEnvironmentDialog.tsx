import { useState } from "react";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconLoader2,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TemplateVersionDiff } from "@/components/stack-templates/template-version-diff";
import { UpgradeRotateGate } from "@/components/stacks/UpgradeRotateGate";
import { useStackTemplateVersions } from "@/hooks/use-stack-templates";
import { useStackUpgradeFlow } from "@/hooks/use-stack-upgrade-flow";
import { planPromotion } from "@/lib/promotion";
import type { StackInfo } from "@mini-infra/types";

/**
 * Promote one environment's installed template version into another.
 *
 * "Promote staging to production" is not a new primitive — it is exactly
 * "upgrade the production stack to the version staging already has". So this is
 * a thin composition over the pieces that already exist: the source stack's
 * `templateVersionId` becomes the target's `targetVersionId`, the existing
 * upgrade flow handles the rotate-inputs gate, and the existing version diff
 * renders the preview. Nothing new on the server.
 *
 * Two cases the naive version gets wrong, both handled here:
 *
 *  - **The target may be ahead.** Promotion is not always forward — a hotfix
 *    published straight to production, or a template rollback, can leave the
 *    target on a *newer* version than the source. That is a legitimate thing to
 *    want (align production with what staging actually validated), and the
 *    server allows it as long as the target version is explicit. But it is a
 *    rollback in effect, so say so plainly rather than calling it a promotion.
 *  - **The target may already be there**, in which case the server answers 409
 *    `STACK_ALREADY_ON_LATEST`. That is a no-op, not a failure — surface it as
 *    "nothing to do" instead of firing an error toast at someone who asked for a
 *    state the system is already in.
 */
export function PromoteToEnvironmentDialog({
  sourceStack,
  stacks,
  environmentNameById,
  open,
  onOpenChange,
}: {
  /** The environment being promoted *from* — its installed version is the payload. */
  sourceStack: StackInfo;
  /** Every stack of this template, source included (filtered out of the picker). */
  stacks: StackInfo[];
  environmentNameById: Map<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Empty string, not null: the Select must be controlled from first render, or
  // React warns as it flips uncontrolled → controlled on the first choice.
  const [targetStackId, setTargetStackId] = useState("");

  const envName = (stack: StackInfo) =>
    stack.environmentId
      ? (environmentNameById.get(stack.environmentId) ?? stack.environmentId)
      : "Host";

  const targets = stacks.filter((s) => s.id !== sourceStack.id);
  const targetStack = targets.find((s) => s.id === targetStackId) ?? null;

  const { data: versions } = useStackTemplateVersions(
    open ? (sourceStack.templateId ?? undefined) : undefined,
  );

  // The diff needs the full version payloads (services included), which the
  // versions endpoint already returns — the stacks themselves only carry the
  // version *number*.
  const sourceVersion = versions?.find((v) => v.id === sourceStack.templateVersionId) ?? null;
  const targetVersion = versions?.find((v) => v.id === targetStack?.templateVersionId) ?? null;

  const flow = useStackUpgradeFlow({
    stackId: targetStack?.id ?? "",
    label: targetStack ? `Promoting to ${envName(targetStack)}` : "Promoting",
    onDone: () => {
      setTargetStackId("");
      onOpenChange(false);
    },
  });

  const { alreadyThere, isBackwards, canPromote } = planPromotion(sourceStack, targetStack);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Promote to another environment</DialogTitle>
            <DialogDescription>
              Deploy the exact template version running in{" "}
              <span className="font-medium">{envName(sourceStack)}</span> into another
              environment.
            </DialogDescription>
          </DialogHeader>

          {targets.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              This application is only deployed in one environment, so there is nowhere to
              promote it to.
            </p>
          ) : sourceStack.templateVersionId == null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {envName(sourceStack)} has no template version installed, so there is nothing to
              promote.
            </p>
          ) : (
            <div className="space-y-4">
              {/* From → To */}
              <div className="flex items-center gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">From</div>
                  <div className="truncate font-medium">{envName(sourceStack)}</div>
                  <Badge variant="secondary" className="mt-1 font-mono">
                    v{sourceStack.templateVersion}
                  </Badge>
                </div>

                <IconArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />

                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-xs text-muted-foreground">To</div>
                  <Select value={targetStackId} onValueChange={setTargetStackId}>
                    <SelectTrigger data-tour="promote-target-environment">
                      <SelectValue placeholder="Choose an environment…" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {envName(s)}
                          {s.templateVersion != null && ` · v${s.templateVersion}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {targetStack && alreadyThere && (
                <Alert>
                  <IconCheck className="h-4 w-4" />
                  <AlertDescription>
                    {envName(targetStack)} is already on v{targetStack.templateVersion}. There is
                    nothing to promote.
                  </AlertDescription>
                </Alert>
              )}

              {targetStack && isBackwards && (
                <Alert variant="destructive">
                  <IconAlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {envName(targetStack)} is on v{targetStack.templateVersion}, which is{" "}
                    <strong>newer</strong> than v{sourceStack.templateVersion}. This will roll it
                    back, not promote it.
                  </AlertDescription>
                </Alert>
              )}

              {targetStack && !alreadyThere && (
                <div>
                  <div className="mb-2 text-sm font-medium">
                    What changes in {envName(targetStack)}
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded-md border p-3">
                    <TemplateVersionDiff
                      from={targetVersion}
                      to={sourceVersion}
                      emptyLabel="These two versions are identical in content."
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={flow.busy}>
              Cancel
            </Button>
            <Button
              variant={isBackwards ? "destructive" : "default"}
              disabled={!canPromote || flow.busy}
              onClick={() =>
                sourceStack.templateVersionId &&
                void flow.start(sourceStack.templateVersionId)
              }
            >
              {flow.busy && <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />}
              {isBackwards
                ? `Roll back to v${sourceStack.templateVersion}`
                : `Deploy v${sourceStack.templateVersion}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UpgradeRotateGate flow={flow} />
    </>
  );
}
