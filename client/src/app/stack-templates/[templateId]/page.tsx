import { useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { IconArrowLeft, IconLoader2 } from "@tabler/icons-react";
import {
  useStackTemplate,
  useStackTemplateVersions,
  useSaveDraft,
  usePublishDraft,
  useDiscardDraft,
} from "@/hooks/use-stack-templates";
import { TemplateMetadataCard } from "@/components/stack-templates/template-metadata-card";
import { TemplateServicesSection } from "@/components/stack-templates/template-services-section";
import { TemplateParametersSection } from "@/components/stack-templates/template-parameters-section";
import { TemplateNetworksVolumes } from "@/components/stack-templates/template-networks-volumes";
import { TemplateConfigFilesSection } from "@/components/stack-templates/config-files/template-config-files-section";
import { TemplateResourceIOSection } from "@/components/stack-templates/template-resource-io-section";
import { VersionSidebar } from "@/components/stack-templates/version-sidebar";
import { CodeView } from "@/components/stack-templates/code-view/code-view";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import type {
  StackServiceDefinition,
  StackParameterDefinition,
  StackParameterValue,
  StackNetwork,
  StackVolume,
  DraftVersionInput,
  StackResourceInput,
  StackResourceOutput,
  StackTemplateConfigFileInput,
} from "@mini-infra/types";

export default function StackTemplateDetailPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { data: template, isLoading, error } = useStackTemplate(templateId ?? "");
  const { data: versions } = useStackTemplateVersions(templateId ?? "");

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReplaceDraft, setConfirmReplaceDraft] = useState(false);
  const [publishNotes, setPublishNotes] = useState("");
  const [viewMode, setViewMode] = useState<"graphical" | "code">("graphical");

  const saveDraftMutation = useSaveDraft();
  const publishDraftMutation = usePublishDraft();
  const discardDraftMutation = useDiscardDraft();

  // Compute display version
  const allVersions = versions ?? [];
  const draftVersion = allVersions.find((v) => v.status === "draft");
  const displayVersion = selectedVersionId
    ? allVersions.find((v) => v.id === selectedVersionId)
    : draftVersion ?? template?.currentVersion ?? undefined;

  const isViewingDraft = !selectedVersionId && !!draftVersion;
  const isViewingHistorical =
    !!selectedVersionId &&
    !!displayVersion &&
    displayVersion.status !== "draft";
  const readOnly = !isViewingDraft;

  // Build draft input from displayVersion with optional overrides. Preserves
  // every optional field so saving one section (e.g. services) doesn't wipe
  // others (config files, resource I/O, network type defaults).
  const buildDraftInput = useCallback(
    (overrides: Partial<DraftVersionInput> = {}): DraftVersionInput => {
      const v = displayVersion;
      return {
        parameters: v?.parameters ?? [],
        defaultParameterValues: v?.defaultParameterValues ?? {},
        networkTypeDefaults: v?.networkTypeDefaults ?? {},
        resourceOutputs: v?.resourceOutputs ?? [],
        resourceInputs: v?.resourceInputs ?? [],
        networks: v?.networks ?? [],
        volumes: v?.volumes ?? [],
        services:
          v?.services?.map((s) => ({
            serviceName: s.serviceName,
            serviceType: s.serviceType,
            dockerImage: s.dockerImage,
            dockerTag: s.dockerTag,
            containerConfig: s.containerConfig,
            initCommands: s.initCommands ?? undefined,
            dependsOn: s.dependsOn,
            order: s.order,
            routing: s.routing ?? undefined,
            adoptedContainer: s.adoptedContainer ?? undefined,
          })) ?? [],
        configFiles:
          v?.configFiles?.map((cf) => ({
            serviceName: cf.serviceName,
            fileName: cf.fileName,
            volumeName: cf.volumeName,
            mountPath: cf.mountPath,
            content: cf.content,
            permissions: cf.permissions ?? undefined,
            owner: cf.owner ?? undefined,
          })) ?? [],
        ...overrides,
      };
    },
    [displayVersion],
  );

  // Draft save handler
  const handleSaveDraft = useCallback(
    async (input: DraftVersionInput) => {
      if (!templateId) return;
      try {
        await saveDraftMutation.mutateAsync({ templateId, request: input });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save draft");
      }
    },
    [templateId, saveDraftMutation],
  );

  const handleServicesChange = useCallback(
    (services: StackServiceDefinition[]) => {
      handleSaveDraft(buildDraftInput({ services }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleParametersChange = useCallback(
    (
      parameters: StackParameterDefinition[],
      defaultParameterValues: Record<string, StackParameterValue>,
      networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>,
    ) => {
      handleSaveDraft(
        buildDraftInput({
          parameters,
          defaultParameterValues,
          ...(networkTypeDefaults !== undefined ? { networkTypeDefaults } : {}),
        }),
      );
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleConfigFilesChange = useCallback(
    (configFiles: StackTemplateConfigFileInput[]) => {
      handleSaveDraft(buildDraftInput({ configFiles }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleResourceIOChange = useCallback(
    (
      resourceInputs: StackResourceInput[],
      resourceOutputs: StackResourceOutput[],
    ) => {
      handleSaveDraft(buildDraftInput({ resourceInputs, resourceOutputs }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleNetworksChange = useCallback(
    (networks: StackNetwork[]) => {
      handleSaveDraft(buildDraftInput({ networks }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleVolumesChange = useCallback(
    (volumes: StackVolume[]) => {
      handleSaveDraft(buildDraftInput({ volumes }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handlePublish = async () => {
    if (!templateId) return;
    try {
      await publishDraftMutation.mutateAsync({
        templateId,
        request: { notes: publishNotes || undefined },
      });
      setConfirmPublish(false);
      setPublishNotes("");
      setSelectedVersionId(null);
      toast.success("Draft published successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to publish draft");
    }
  };

  const handleDiscard = async () => {
    if (!templateId) return;
    try {
      await discardDraftMutation.mutateAsync(templateId);
      setConfirmDiscard(false);
      toast.success("Draft discarded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to discard draft");
    }
  };

  const handleCreateDraft = async () => {
    await handleSaveDraft(buildDraftInput());
    toast.success("Draft created");
  };

  // "Create Draft from this version" — copies the currently displayed
  // historical version into a new draft. If a draft already exists, replacing
  // it needs explicit confirmation.
  const handleCreateDraftFromVersion = async () => {
    await handleSaveDraft(buildDraftInput());
    setSelectedVersionId(null);
    setConfirmReplaceDraft(false);
    toast.success(
      `Draft created from v${displayVersion?.version ?? ""}`.trim(),
    );
  };

  function onCreateDraftFromVersionClick() {
    if (draftVersion) {
      setConfirmReplaceDraft(true);
    } else {
      void handleCreateDraftFromVersion();
    }
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 lg:px-6 py-3 border-b">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-6 w-48" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-60 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
          <div className="w-[280px] border-l bg-muted/30 hidden lg:block">
            <Skeleton className="h-full w-full" />
          </div>
        </div>
      </div>
    );
  }

  // Error / not found state
  if (error || !template) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 lg:px-6 py-3 border-b">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/stack-templates">
              <IconArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <Alert className="max-w-md">
            <AlertDescription>
              {error instanceof Error ? error.message : "Template not found."}
              <div className="mt-3">
                <Button variant="outline" size="sm" asChild>
                  <Link to="/stack-templates">Return to Templates</Link>
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 lg:px-6 py-3 border-b gap-3 flex-wrap">
        {/* Left: back + name + badges */}
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <Link to="/stack-templates">
              <IconArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
          <span className="font-semibold text-sm truncate">{template.displayName}</span>
          <div className="flex items-center gap-2 shrink-0">
            {isViewingHistorical && displayVersion ? (
              <Badge className="bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                Viewing v{displayVersion.version}
              </Badge>
            ) : isViewingDraft ? (
              <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
                Editing Draft
              </Badge>
            ) : template.currentVersion ? (
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
                Published v{template.currentVersion.version}
              </Badge>
            ) : null}
            {/* Secondary badge: show draft indicator while viewing published/historical. */}
            {draftVersion && !isViewingDraft && (
              <Badge
                variant="outline"
                className="text-orange-700 border-orange-300 dark:text-orange-300 dark:border-orange-700"
              >
                Draft exists
              </Badge>
            )}
          </div>
        </div>

        {/* Right: view toggle + action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <ToggleGroup
            type="single"
            size="sm"
            value={viewMode}
            onValueChange={(v) => v && setViewMode(v as "graphical" | "code")}
            variant="outline"
          >
            <ToggleGroupItem value="graphical" aria-label="Graphical">
              Graphical
            </ToggleGroupItem>
            <ToggleGroupItem value="code" aria-label="Code">
              Code
            </ToggleGroupItem>
          </ToggleGroup>
          {isViewingHistorical && displayVersion ? (
            <>
              {draftVersion && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedVersionId(null)}
                >
                  Back to Draft
                </Button>
              )}
              <Button
                size="sm"
                onClick={onCreateDraftFromVersionClick}
                disabled={saveDraftMutation.isPending}
              >
                {saveDraftMutation.isPending && (
                  <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Create Draft from v{displayVersion.version}
              </Button>
            </>
          ) : draftVersion ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDiscard(true)}
                disabled={discardDraftMutation.isPending}
              >
                {discardDraftMutation.isPending && (
                  <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Discard Draft
              </Button>
              <Button
                size="sm"
                onClick={() => setConfirmPublish(true)}
                disabled={publishDraftMutation.isPending}
              >
                {publishDraftMutation.isPending && (
                  <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                Publish Draft
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={handleCreateDraft}
              disabled={saveDraftMutation.isPending}
            >
              {saveDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Create Draft
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor */}
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {viewMode === "graphical" ? (
            <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
              {isViewingHistorical && displayVersion && (
                <Alert className="bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800">
                  <AlertDescription>
                    Viewing <span className="font-mono">v{displayVersion.version}</span>{" "}
                    ({displayVersion.status}) — read-only. Use{" "}
                    <span className="font-medium">
                      Create Draft from v{displayVersion.version}
                    </span>{" "}
                    to edit or roll back.
                  </AlertDescription>
                </Alert>
              )}
              <TemplateMetadataCard template={template} readOnly={readOnly} />

              {displayVersion ? (
                <>
                  <TemplateServicesSection
                    services={displayVersion.services ?? []}
                    allServiceNames={(displayVersion.services ?? []).map((s) => s.serviceName)}
                    readOnly={readOnly}
                    onServicesChange={handleServicesChange}
                  />
                  <TemplateParametersSection
                    parameters={displayVersion.parameters ?? []}
                    defaultParameterValues={displayVersion.defaultParameterValues ?? {}}
                    networkTypeDefaults={displayVersion.networkTypeDefaults}
                    templateNetworkType={template.networkType}
                    readOnly={readOnly}
                    onParametersChange={handleParametersChange}
                  />
                  <TemplateNetworksVolumes
                    networks={displayVersion.networks ?? []}
                    volumes={displayVersion.volumes ?? []}
                    readOnly={readOnly}
                    onNetworksChange={handleNetworksChange}
                    onVolumesChange={handleVolumesChange}
                  />
                  <TemplateConfigFilesSection
                    configFiles={displayVersion.configFiles ?? []}
                    serviceNames={(displayVersion.services ?? []).map((s) => s.serviceName)}
                    volumeNames={(displayVersion.volumes ?? []).map((v) => v.name)}
                    readOnly={readOnly}
                    onConfigFilesChange={handleConfigFilesChange}
                  />
                  <TemplateResourceIOSection
                    resourceInputs={displayVersion.resourceInputs ?? []}
                    resourceOutputs={displayVersion.resourceOutputs ?? []}
                    readOnly={readOnly}
                    onChange={handleResourceIOChange}
                  />
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                  <p className="text-sm">
                    No version data available. Create a draft to start editing.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 p-4 lg:p-6">
              {displayVersion ? (
                <CodeView
                  version={displayVersion}
                  readOnly={readOnly}
                  saving={saveDraftMutation.isPending}
                  onSave={handleSaveDraft}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No version data available. Create a draft to start editing.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Version Sidebar */}
        <div className="w-[280px] border-l bg-muted/30 hidden lg:block shrink-0">
          <VersionSidebar
            template={template}
            versions={allVersions}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
          />
        </div>
      </div>

      {/* Publish Dialog */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish Draft</AlertDialogTitle>
            <AlertDialogDescription>
              This will publish the current draft as the new active version of this
              template. All future deployments will use this version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Textarea
              placeholder="Release notes (optional)"
              value={publishNotes}
              onChange={(e) => setPublishNotes(e.target.value)}
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePublish}
              disabled={publishDraftMutation.isPending}
            >
              {publishDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard Dialog */}
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard Draft</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to discard the current draft? This action cannot be
              undone and all unsaved changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDiscard}
              disabled={discardDraftMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {discardDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Discard Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Replace-Draft Confirm (shown when creating draft from a historical
          version while a draft already exists). */}
      <AlertDialog open={confirmReplaceDraft} onOpenChange={setConfirmReplaceDraft}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace existing draft?</AlertDialogTitle>
            <AlertDialogDescription>
              You already have a draft in progress. Creating a new draft from
              v{displayVersion?.version} will overwrite it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCreateDraftFromVersion}
              disabled={saveDraftMutation.isPending}
            >
              {saveDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Replace Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
