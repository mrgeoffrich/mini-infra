import { useMemo, useState } from "react";
import {
  IconArrowBackUp,
  IconDatabase,
  IconDots,
  IconExternalLink,
  IconLoader2,
  IconPencil,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlugConnected,
  IconPlugConnectedX,
  IconRefresh,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDeployApplicationUpdate } from "@/hooks/use-applications";
import { useTaskTracker } from "@/hooks/use-task-tracker";
import { Channel } from "@mini-infra/types";
import type {
  StackInfo,
  StackServiceInfo,
  StackServiceType,
  StackTemplateInfo,
} from "@mini-infra/types";

interface ApplicationCardProps {
  app: StackTemplateInfo;
  appStacks: StackInfo[] | undefined;
  environmentName: string | undefined;
  appUrl: string | null;
  adopted: boolean;
  serviceType: StackServiceType | null;
  isBusy: boolean;
  isStopping: boolean;
  onDeploy: (app: StackTemplateInfo) => void;
  onStop: (app: StackTemplateInfo) => void;
  onDelete: (app: StackTemplateInfo) => void;
  onEdit: (app: StackTemplateInfo) => void;
}

const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function pickPrimaryService(stack: StackInfo | undefined): StackServiceInfo | null {
  if (!stack?.services?.length) return null;
  const editable = stack.services.find(
    (s) => s.serviceType === "StatelessWeb" || s.serviceType === "Stateful",
  );
  return editable ?? null;
}

export function ApplicationCard({
  app,
  appStacks,
  environmentName,
  appUrl,
  adopted,
  serviceType,
  isBusy,
  isStopping,
  onDeploy,
  onStop,
  onDelete,
  onEdit,
}: ApplicationCardProps) {
  const [flipped, setFlipped] = useState(false);
  const hasStacks = !!appStacks && appStacks.length > 0;
  const primaryStack = useMemo(
    () =>
      appStacks?.find((s) => s.status === "synced")
        ?? appStacks?.find((s) => s.status === "pending")
        ?? appStacks?.[0]
        ?? null,
    [appStacks],
  );
  const primaryService = useMemo(
    () => pickPrimaryService(primaryStack ?? undefined),
    [primaryStack],
  );

  const currentTag = primaryService?.dockerTag ?? "";
  const [tagDraft, setTagDraft] = useState(currentTag);

  // Don't show the flipped face while the stack is churning — the busy overlay
  // takes precedence. Derived rather than an effect to avoid cascading renders.
  const effectivelyFlipped = flipped && !isBusy;

  const openUpdateForm = () => {
    setTagDraft(currentTag);
    setFlipped(true);
  };
  const closeUpdateForm = () => setFlipped(false);

  const { registerTask } = useTaskTracker();
  const deployUpdate = useDeployApplicationUpdate();

  const trimmedTag = tagDraft.trim();
  const tagChanged = trimmedTag !== currentTag;
  const tagValid = DOCKER_TAG_PATTERN.test(trimmedTag);

  const handleDeployUpdate = async () => {
    if (!primaryStack || !primaryService || !tagValid) return;
    try {
      registerTask({
        id: primaryStack.id,
        type: "stack-update",
        label: `Updating ${app.displayName ?? app.name}`,
        channel: Channel.STACKS,
      });
      await deployUpdate.mutateAsync({
        stackId: primaryStack.id,
        serviceName: primaryService.serviceName,
        newTag: trimmedTag,
        currentTag,
      });
      closeUpdateForm();
    } catch {
      // toast handled by mutation onError
    }
  };

  const deployDisabled =
    !primaryService || !tagValid || deployUpdate.isPending;

  return (
    <div className="[perspective:1000px]">
      <div
        className={cn(
          "grid transition-transform duration-500 [transform-style:preserve-3d]",
          effectivelyFlipped && "[transform:rotateY(180deg)]",
          isBusy && "opacity-60 pointer-events-none",
        )}
      >
        {/* FRONT */}
        <Card
          className={cn(
            "group flex flex-col transition-shadow [grid-area:1/1] [backface-visibility:hidden]",
            !isBusy && "hover:shadow-md",
          )}
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <CardTitle className="text-base truncate flex items-center gap-1.5">
                  {serviceType === "AdoptedWeb" && (
                    <IconPlugConnected className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  {serviceType === "StatelessWeb" && (
                    <IconWorld className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  {serviceType === "Stateful" && (
                    <IconDatabase className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  {app.displayName}
                </CardTitle>
                {appUrl && (
                  <a
                    href={appUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="truncate">
                      {appUrl.replace("https://", "")}
                    </span>
                    <IconExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}
                {app.description && (
                  <CardDescription className="mt-1 line-clamp-2">
                    {app.description}
                  </CardDescription>
                )}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                  >
                    <IconDots className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit(app)}>
                    <IconPencil className="h-4 w-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDelete(app)}
                  >
                    <IconTrash className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>

          <CardContent className="pt-0 flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {app.isArchived && <Badge variant="destructive">Archived</Badge>}
              {primaryStack && (
                <Badge
                  variant={
                    primaryStack.status === "synced" ? "default" : "outline"
                  }
                >
                  {primaryStack.status === "synced"
                    ? adopted
                      ? "Connected"
                      : "Running"
                    : primaryStack.status ?? "Deployed"}
                </Badge>
              )}
              {app.environmentId && environmentName && (
                <Badge variant="outline" className="text-xs">
                  {environmentName}
                </Badge>
              )}
            </div>

            {primaryService && (
              <div className="text-xs text-muted-foreground mb-3 truncate">
                <span className="font-mono">
                  {primaryService.dockerImage}
                  {primaryService.dockerTag ? `:${primaryService.dockerTag}` : ""}
                </span>
              </div>
            )}

            <div className="flex gap-2 mt-auto">
              {!hasStacks && app.environmentId && (
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => onDeploy(app)}
                >
                  {adopted ? (
                    <IconPlugConnected className="h-4 w-4 mr-1" />
                  ) : (
                    <IconPlayerPlay className="h-4 w-4 mr-1" />
                  )}
                  {adopted ? "Connect" : "Deploy"}
                </Button>
              )}
              {hasStacks && (
                <>
                  {!adopted && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={openUpdateForm}
                    >
                      <IconRefresh className="h-4 w-4 mr-1" />
                      Update
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    disabled={isStopping}
                    onClick={() => onStop(app)}
                  >
                    {isStopping ? (
                      <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : adopted ? (
                      <IconPlugConnectedX className="h-4 w-4 mr-1" />
                    ) : (
                      <IconPlayerStop className="h-4 w-4 mr-1" />
                    )}
                    {adopted ? "Disconnect" : "Stop"}
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* BACK */}
        <Card
          className="flex flex-col [grid-area:1/1] [backface-visibility:hidden] [transform:rotateY(180deg)]"
          aria-hidden={!effectivelyFlipped}
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <CardTitle className="text-base truncate flex items-center gap-1.5">
                  <IconRefresh className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Update {app.displayName}
                </CardTitle>
                <CardDescription className="mt-0.5 text-xs">
                  Edit the image tag and deploy a new version.
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={closeUpdateForm}
                aria-label="Close update form"
                tabIndex={effectivelyFlipped ? 0 : -1}
              >
                <IconArrowBackUp className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="pt-0 flex-1 flex flex-col space-y-3">
            {primaryService ? (
              <>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex gap-2">
                    <span className="font-medium text-foreground/80">Service:</span>
                    <span className="truncate">{primaryService.serviceName}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="font-medium text-foreground/80">Image:</span>
                    <span className="truncate font-mono">
                      {primaryService.dockerImage}
                    </span>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor={`tag-${app.id}`} className="text-xs">
                    Tag
                  </Label>
                  <Input
                    id={`tag-${app.id}`}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder={currentTag || "latest"}
                    className="font-mono text-sm h-9"
                    tabIndex={effectivelyFlipped ? 0 : -1}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {!tagValid && trimmedTag.length > 0 && (
                    <p className="text-xs text-destructive">
                      Invalid tag. Use letters, digits, dots, dashes, or underscores.
                    </p>
                  )}
                  {!trimmedTag && (
                    <p className="text-xs text-muted-foreground">
                      Tag is required.
                    </p>
                  )}
                </div>

                <div className="flex gap-2 pt-1 mt-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={closeUpdateForm}
                    tabIndex={effectivelyFlipped ? 0 : -1}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={handleDeployUpdate}
                    disabled={deployDisabled}
                    tabIndex={effectivelyFlipped ? 0 : -1}
                  >
                    {deployUpdate.isPending ? (
                      <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <IconRefresh className="h-4 w-4 mr-1" />
                    )}
                    {tagChanged ? "Deploy" : "Redeploy"}
                  </Button>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground py-4 text-center">
                No editable service on this application.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
