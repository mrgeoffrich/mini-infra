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
import {
  IconArrowLeft,
  IconLoader2,
  IconGitCompare,
  IconRocket,
  IconDownload,
} from "@tabler/icons-react";
import {
  useStackTemplate,
  useStackTemplateVersions,
  useSaveDraft,
  usePublishDraft,
  useDiscardDraft,
  useExportTemplateVersion,
} from "@/hooks/use-stack-templates";
import { TemplateVersionDiff } from "@/components/stack-templates/template-version-diff";
import { InstantiateTemplateDialog } from "@/components/stack-templates/instantiate-template-dialog";
import { TemplateMetadataCard } from "@/components/stack-templates/template-metadata-card";
import { TemplateServicesSection } from "@/components/stack-templates/template-services-section";
import { TemplateParametersSection } from "@/components/stack-templates/template-parameters-section";
import { TemplateNetworksVolumes } from "@/components/stack-templates/template-networks-volumes";
import { TemplateConfigFilesSection } from "@/components/stack-templates/config-files/template-config-files-section";
import { TemplateResourceIOSection } from "@/components/stack-templates/template-resource-io-section";
import { TemplateInputsSection } from "@/components/stack-templates/template-inputs-section";
import { TemplateRequiresSection } from "@/components/stack-templates/template-requires-section";
import { VersionSidebar } from "@/components/stack-templates/version-sidebar";
import { CodeView } from "@/components/stack-templates/code-view/code-view";
import { buildDraftFromVersion } from "@/lib/application-draft";
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
  TemplateInputDeclaration,
  StackTemplatePrerequisite,
  StackTemplateConfigFileInput,
} from "@mini-infra/types";

export default function StackTemplateDetailPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { data: template, isLoading, error } = useStackTemplate(templateId ?? "", {
    includeLinkedStacks: true,
  });
  const { data: versions } = useStackTemplateVersions(templateId ?? "");

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReplaceDraft, setConfirmReplaceDraft] = useState(false);
  const [publishNotes, setPublishNotes] = useState("");
  const [viewMode, setViewMode] = useState<"graphical" | "code">("graphical");
  const [showDiff, setShowDiff] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  const saveDraftMutation = useSaveDraft();
  const publishDraftMutation = usePublishDraft();
  const discardDraftMutation = useDiscardDraft();
  const exportMutation = useExportTemplateVersion();

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

  // System templates are managed by Mini Infra and immutable via the API —
  // render explicitly read-only rather than offering draft/publish affordances
  // that fail server-side (STACK_TEMPLATE_SYSTEM_IMMUTABLE).
  const isSystem = template?.source === "system";

  // Predecessor of the displayed version, for the "compare with previous" diff.
  const historyVersions = [...allVersions]
    .filter((v) => v.status !== "draft")
    .sort((a, b) => b.version - a.version);
  const previousVersion =
    displayVersion && displayVersion.status !== "draft"
      ? historyVersions.find((v) => v.version < displayVersion.version)
      : undefined;
  const currentPublishedVersion = template?.currentVersion ?? undefined;
  const canInstall = !!currentPublishedVersion;

  // Build draft input from displayVersion with optional overrides. Delegates to
  // the canonical LOSSLESS mapper (`buildDraftFromVersion`) so saving one
  // section (e.g. services) carries every other field through untouched —
  // config files, resource I/O, network type defaults, notes, inputs, vault,
  // nats, requires, AND every per-service field (`addons`, `poolConfig`,
  // `jobPoolConfig`, vault/nats binding refs). A hand-rolled partial map here
  // used to silently strip those, so editing/deleting any one service wiped
  // addons off every service (and dropping the version-level nats/vault section
  // while keeping a service's `natsRole`/`vaultAppRoleRef` would then fail
  // validation). `buildDraftFromVersion` also strips read-model `null`s.
  const buildDraftInput = useCallback(
    (overrides: Partial<DraftVersionInput> = {}): DraftVersionInput => {
      const base: DraftVersionInput = displayVersion
        ? buildDraftFromVersion(displayVersion)
        : {
            parameters: [],
            defaultParameterValues: {},
            networkTypeDefaults: {},
            resourceOutputs: [],
            resourceInputs: [],
            networks: [],
            volumes: [],
            services: [],
            configFiles: [],
          };
      return { ...base, ...overrides };
    },
    [displayVersion],
  );

  // Draft save handler
  const handleSaveDraft = useCallback(
    async (input: DraftVersionInput) => {
      if (!templateId) return;
      try {
        await saveDraftMutation.mutateAsync({ templateId, request: input });
      } catch {
        // Swallow: the global MutationCache.onError (query-client.ts)
        // already shows an actionable toast for this mutation's real
        // ApiRequestError. We only need to catch here so mutateAsync's
        // rejection doesn't become an unhandled promise rejection.
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

  const handleInputsChange = useCallback(
    (inputs: TemplateInputDeclaration[]) => {
      handleSaveDraft(buildDraftInput({ inputs }));
    },
    [handleSaveDraft, buildDraftInput],
  );

  const handleRequiresChange = useCallback(
    (requires: StackTemplatePrerequisite[]) => {
      handleSaveDraft(buildDraftInput({ requires }));
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
    } catch {
      // Swallow: the global MutationCache.onError already shows an
      // actionable toast — keeping the dialog open so the operator can
      // retry (see handleSaveDraft above).
    }
  };

  const handleDiscard = async () => {
    if (!templateId) return;
    try {
      await discardDraftMutation.mutateAsync(templateId);
      setConfirmDiscard(false);
      toast.success("Draft discarded");
    } catch {
      // Swallow: the global MutationCache.onError already shows an
      // actionable toast.
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

  // Export the currently-displayed version to a portable YAML file. The server
  // redacts literal secrets and reports what it removed; surface that so the
  // operator knows the file isn't a full backup.
  const handleExportVersion = async () => {
    if (!templateId || !displayVersion) return;
    try {
      const { filename, yaml, issues } = await exportMutation.mutateAsync({
        templateId,
        versionId: displayVersion.id,
      });
      const blob = new Blob([yaml], { type: "application/yaml" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      const redactions = issues.filter((i) => i.level === "lossy").length;
      toast.success(
        redactions > 0
          ? `Exported ${filename} — ${redactions} secret${redactions === 1 ? "" : "s"} redacted; set them again on import`
          : `Exported ${filename}`,
      );
    } catch {
      // Global MutationCache.onError surfaces an actionable toast.
    }
  };

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
          {previousVersion && (
            <Button
              variant={showDiff ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowDiff((v) => !v)}
            >
              <IconGitCompare className="h-4 w-4 mr-1" />
              {showDiff ? "Hide changes" : "Compare"}
            </Button>
          )}
          {canInstall && (
            <Button variant="outline" size="sm" onClick={() => setShowInstall(true)}>
              <IconRocket className="h-4 w-4 mr-1" />
              Install
            </Button>
          )}
          {displayVersion && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleExportVersion()}
              disabled={exportMutation.isPending}
              data-tour="export-template-button"
            >
              {exportMutation.isPending ? (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <IconDownload className="h-4 w-4 mr-1" />
              )}
              Export
            </Button>
          )}
          {isSystem ? (
            <span className="text-xs text-muted-foreground max-w-[16rem]">
              System template — updated with Mini Infra releases
            </span>
          ) : isViewingHistorical && displayVersion ? (
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
              {isSystem && (
                <Alert className="bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800">
                  <AlertDescription>
                    This is a <span className="font-medium">system template</span> — it&apos;s
                    managed by Mini Infra and updated with releases, so it can&apos;t be
                    edited here.
                  </AlertDescription>
                </Alert>
              )}
              {!isSystem && isViewingHistorical && displayVersion && (
                <Alert className="bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800">
                  <AlertDescription>
                    Viewing <span className="font-mono">v{displayVersion.version}</span>{" "}
                    ({displayVersion.status}) — read-only. Use{" "}
                    <span className="font-medium">
                      Create Draft from v{displayVersion.version}
                    </span>{" "}
                    to edit, or <span className="font-medium">Make current</span> in the
                    version list to roll back to it.
                  </AlertDescription>
                </Alert>
              )}
              {showDiff && previousVersion && displayVersion && (
                <div className="rounded-md border p-4">
                  <div className="mb-3 text-sm font-medium">
                    Changes from v{previousVersion.version} → v{displayVersion.version}
                  </div>
                  <TemplateVersionDiff from={previousVersion} to={displayVersion} />
                </div>
              )}
              {/* Metadata (name/description/category) is version-independent and
                  editable without a draft — only system templates are locked. */}
              <TemplateMetadataCard template={template} readOnly={isSystem} />

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
                  <TemplateInputsSection
                    inputs={displayVersion.inputs ?? []}
                    readOnly={readOnly}
                    onChange={handleInputsChange}
                  />
                  <TemplateRequiresSection
                    requires={displayVersion.requires ?? []}
                    readOnly={readOnly}
                    onChange={handleRequiresChange}
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
            canManageVersions={!isSystem}
          />
        </div>
      </div>

      {/* Publish Dialog */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish Draft</AlertDialogTitle>
            <AlertDialogDescription>
              This publishes the draft as the template&apos;s new current version.
              New installs use it, and existing stacks show an update they can
              upgrade to — they aren&apos;t changed automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {draftVersion && (
            <div className="max-h-64 overflow-y-auto rounded-md border p-3">
              <div className="mb-2 text-sm font-medium">
                What you&apos;re shipping
                {currentPublishedVersion
                  ? ` (v${currentPublishedVersion.version} → new version)`
                  : " (first version)"}
              </div>
              {currentPublishedVersion ? (
                <TemplateVersionDiff
                  from={currentPublishedVersion}
                  to={draftVersion}
                  emptyLabel="No changes from the current published version."
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This is the template&apos;s first published version.
                </p>
              )}
            </div>
          )}
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

      {/* Install dialog — reachable from the top-bar "Install" button. */}
      <InstantiateTemplateDialog
        open={showInstall}
        onOpenChange={setShowInstall}
        template={template}
      />
    </div>
  );
}
