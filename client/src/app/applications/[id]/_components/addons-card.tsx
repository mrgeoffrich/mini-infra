import { useMemo, useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { StackTemplateInfo } from "@mini-infra/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AddonBadge } from "@/components/stacks/addon-badge";
import { AttachAddonDialog } from "@/components/stacks/attach-addon-dialog";
import { useAddonCatalog } from "@/hooks/use-addon-catalog";
import { useUpdateApplication } from "@/hooks/use-applications";
import { buildDraftFromVersion } from "@/lib/application-draft";

interface AddonsCardProps {
  /** The application's stack template — id + version drive attach/remove. */
  templateId: string;
  template: StackTemplateInfo;
}

/**
 * Application Overview "Add-ons" card. Lists the Service Addons declared on the
 * application's primary service and offers an attach action (the shared
 * `AttachAddonDialog`). Attach and remove both republish the template through
 * the LOSSLESS path (`buildDraftFromVersion`, §4.2 of the addon-authoring-ui
 * plan) — overlaying only `services[0].addons` so nothing else the form
 * doesn't model (`vault`, `nats`, `resourceInputs`, `joinNetworks`, …) is
 * dropped. Mirrors the Connected Networks card's `persistJoinNetworks`.
 *
 * Unlike the Connect card (which needs an applied snapshot), this card renders
 * off the template's current-or-draft version, so an operator can attach
 * addons at config time — before the app's first deploy.
 */
export function AddonsCard({ templateId, template }: AddonsCardProps) {
  const version = template.currentVersion ?? template.draftVersion ?? null;
  const primaryService = version?.services?.[0] ?? null;

  const updateApplication = useUpdateApplication();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Catalog is used only to enrich the read-out rows with descriptions; the
  // dialog fetches it too, and both share the one cached query.
  const { data: catalogData } = useAddonCatalog();
  const catalogById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalogData?.addons ?? []) {
      map.set(entry.id, entry.description);
    }
    return map;
  }, [catalogData?.addons]);

  const declared = useMemo(
    () => (primaryService?.addons ?? {}) as Record<string, unknown>,
    [primaryService],
  );
  const attachedIds = useMemo(() => Object.keys(declared), [declared]);

  // Nothing to author against until the template has a version. (Applications
  // always have one by the time their detail page renders, so this is a guard,
  // not an expected empty state.)
  if (!version || !primaryService) return null;

  const persistAddons = async (next: Record<string, unknown>) => {
    const draft = buildDraftFromVersion(version);
    const svc = draft.services[0];
    if (!svc) return;
    draft.services[0] = { ...svc, addons: next };
    try {
      await updateApplication.mutateAsync({
        templateId,
        metadata: {
          displayName: template.displayName,
          description: template.description ?? undefined,
        },
        draft,
      });
    } catch {
      // Error surfaced by the mutation hook's global toast.
    }
  };

  const handleAttach = (addonId: string, config: Record<string, unknown>) => {
    void persistAddons({ ...declared, [addonId]: config });
  };

  const handleRemove = (addonId: string) => {
    const next = { ...declared };
    delete next[addonId];
    void persistAddons(next);
  };

  return (
    <Card data-tour="addons-card">
      <CardHeader>
        <CardTitle>Add-ons</CardTitle>
        <CardDescription>
          Attach capabilities like Tailscale SSH or HTTPS to this application.
          Changes take effect on the next redeploy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {attachedIds.length > 0 ? (
          <ul className="divide-y">
            {attachedIds.map((id) => (
              <li
                key={id}
                data-testid={`attached-addon-${id}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <AddonBadge addonName={id} />
                  <span className="text-xs text-muted-foreground truncate">
                    {catalogById.get(id) ?? "Attached add-on"}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => handleRemove(id)}
                  disabled={updateApplication.isPending}
                  aria-label={`Remove ${id} add-on`}
                >
                  <IconTrash className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No add-ons attached yet.
          </p>
        )}

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDialogOpen(true)}
            disabled={updateApplication.isPending}
          >
            <IconPlus className="mr-1 h-4 w-4" />
            Add add-on
          </Button>
        </div>

        {attachedIds.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Add-on changes take effect on the next redeploy — Stop, then Deploy
            this application to apply them.
          </p>
        )}
      </CardContent>

      <AttachAddonDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        serviceName={primaryService.serviceName}
        serviceType={primaryService.serviceType}
        attachedAddonIds={attachedIds}
        onAttach={handleAttach}
        onRemove={handleRemove}
        isPending={updateApplication.isPending}
      />
    </Card>
  );
}
