import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconNetwork,
  IconChevronRight,
  IconTrash,
  IconPlus,
  IconClock,
} from "@tabler/icons-react";
import type {
  ManagedNetworkView,
  StackServiceInfo,
  StackTemplateInfo,
} from "@mini-infra/types";
import { useManagedNetworks, useNetworks } from "@/hooks/use-networks";
import { useUpdateApplication } from "@/hooks/use-applications";
import { buildDraftFromVersion } from "@/lib/application-draft";
import { ManagedNetworkDetailSheet } from "@/components/networks/managed-network-detail-sheet";
import {
  MembershipSourceBadge,
  NetworkExistenceBadge,
} from "@/components/networks/managed-network-shared";
import { membershipTargetLabel } from "@/components/networks/managed-network-helpers";
import {
  computeAddableNetworks,
  computeConnectedNetworkRows,
  type ConnectedNetworkRow,
} from "./connected-networks-model";

interface ConnectedNetworksCardProps {
  stackId: string | undefined;
  /**
   * This application's own stack services — needed to identify which
   * membership row on a SHARED network (one this app merely joins, not
   * owns — egress, applications, resource networks, ...) is actually this
   * app's own, versus some OTHER stack's/service's row that happens to
   * share the network. Only `id`/`adoptedContainer` are read.
   */
  services?: Pick<StackServiceInfo, "id" | "adoptedContainer">[];
  /** The application's stack template — the id + current version drive add/remove. */
  templateId: string;
  template: StackTemplateInfo;
}

function PendingBadge({ kind }: { kind: "add" | "removal" }) {
  return (
    <Badge
      variant="outline"
      className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300"
    >
      <IconClock className="h-3 w-3 mr-1" />
      {kind === "add" ? "Pending" : "Pending removal"}
    </Badge>
  );
}

function rowSubtitle(row: ConnectedNetworkRow): string {
  switch (row.state) {
    case "pending-add":
      return "Declared — redeploy to attach";
    case "pending-removal":
      return "Attached — redeploy to detach";
    default:
      return row.ownMembership ? membershipTargetLabel(row.ownMembership) : "";
  }
}

/**
 * Application detail's "Connected Networks" card. Lists every Docker network
 * this application's primary stack owns or joins, reconciling the app's
 * *declared* network set (its primary service's `joinNetworks`) against the
 * *live* compiled memberships so declared-but-not-yet-attached and
 * removed-but-still-live networks surface as pending until the next redeploy.
 * Lets the operator add a network directly or remove one they added; the edit
 * republishes the template (via `useUpdateApplication`) and takes effect on the
 * app's next Stop → Deploy.
 */
export function ConnectedNetworksCard({
  stackId,
  services,
  templateId,
  template,
}: ConnectedNetworksCardProps) {
  const { data, isLoading, error } = useManagedNetworks(
    { stackId },
    { enabled: !!stackId },
  );
  const { data: rawNetworksData } = useNetworks({ enabled: !!stackId });
  const updateApplication = useUpdateApplication();

  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingPick, setPendingPick] = useState("");

  const version = template.currentVersion ?? template.draftVersion ?? null;
  const primaryService = version?.services?.[0];

  const live = useMemo(() => data ?? [], [data]);
  const rawNetworks = useMemo(
    () => rawNetworksData?.networks ?? [],
    [rawNetworksData],
  );
  const declared = useMemo(
    () => primaryService?.containerConfig?.joinNetworks ?? [],
    [primaryService],
  );
  const ownNames = useMemo(
    () =>
      new Set<string>([
        ...(version?.networks ?? []).map((n) => n.name),
        `${template.name}-net`,
      ]),
    [version, template.name],
  );
  // Adopted-container names, used to recognise this app's own row on a shared
  // network (an adopted container has no resolvable stackServiceId/stackId).
  const ownContainerNames = useMemo(
    () =>
      new Set(
        (services ?? [])
          .map((s) => s.adoptedContainer?.containerName)
          .filter((name): name is string => Boolean(name)),
      ),
    [services],
  );

  const rows = useMemo(
    () =>
      computeConnectedNetworkRows({
        live,
        declared,
        ownNames,
        stackId,
        ownContainerNames,
        rawNetworks,
      }),
    [live, declared, ownNames, stackId, ownContainerNames, rawNetworks],
  );
  const addable = useMemo(
    () => computeAddableNetworks(rawNetworks, ownNames, declared, live),
    [rawNetworks, ownNames, declared, live],
  );

  if (!stackId) return null;

  const selectedNetwork = live.find((n) => n.id === selectedNetworkId) ?? null;
  const hasPending = rows.some((r) => r.state !== "attached");

  const openDetail = (network: ManagedNetworkView) => {
    setSelectedNetworkId(network.id);
    setDetailOpen(true);
  };

  const persistJoinNetworks = async (next: string[]) => {
    if (!version || !primaryService) return;
    const draft = buildDraftFromVersion(version);
    const svc = draft.services[0];
    if (!svc) return;
    draft.services[0] = {
      ...svc,
      containerConfig: { ...svc.containerConfig, joinNetworks: next },
    };
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
      // Error surfaced by the mutation hook's toast.
    }
  };

  const handleAdd = () => {
    if (!pendingPick) return;
    const next = Array.from(new Set([...declared, pendingPick]));
    setPendingPick("");
    void persistJoinNetworks(next);
  };

  const handleRemove = (name: string) => {
    void persistJoinNetworks(declared.filter((n) => n !== name));
  };

  if (isLoading) {
    return (
      <Card data-tour="connected-networks-card">
        <CardHeader>
          <CardTitle>Connected Networks</CardTitle>
          <CardDescription>Docker networks this application is attached to.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) return null;

  return (
    <Card data-tour="connected-networks-card">
      <CardHeader>
        <CardTitle>Connected Networks</CardTitle>
        <CardDescription>
          Docker networks this application is attached to, and why. Add or remove
          networks below; changes attach on the next redeploy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length > 0 && (
          <ul className="divide-y">
            {rows.map((row) => {
              const clickable = !!row.network;
              const content = (
                <>
                  <div className="min-w-0 flex items-center gap-2">
                    <IconNetwork className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{row.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {rowSubtitle(row)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {row.state === "pending-add" && <PendingBadge kind="add" />}
                    {row.state === "pending-removal" && (
                      <PendingBadge kind="removal" />
                    )}
                    {row.ownMembership && (
                      <MembershipSourceBadge
                        source={row.ownMembership.source}
                        createdByName={row.ownMembership.createdByName}
                      />
                    )}
                    {row.network && (
                      <NetworkExistenceBadge existence={row.network.existence} />
                    )}
                    {clickable && (
                      <IconChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </>
              );
              return (
                <li key={row.name} className="flex items-center gap-1">
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => row.network && openDetail(row.network)}
                      className="flex-1 min-w-0 flex items-center justify-between gap-3 py-2.5 text-left hover:bg-accent/50 rounded-md px-1.5 -mx-1.5 transition-colors"
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-3 py-2.5 px-1.5 -mx-1.5">
                      {content}
                    </div>
                  )}
                  {row.removable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => handleRemove(row.name)}
                      disabled={updateApplication.isPending}
                      aria-label={`Remove network ${row.name}`}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Add a network directly (declarative join) */}
        <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center">
          <Select
            value={pendingPick}
            onValueChange={setPendingPick}
            disabled={
              addable.length === 0 ||
              updateApplication.isPending ||
              !primaryService
            }
          >
            <SelectTrigger className="w-full sm:flex-1">
              <SelectValue
                placeholder={
                  addable.length === 0
                    ? "No networks available to add"
                    : "Select a network to join"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {addable.map((net) => (
                <SelectItem key={net.id} value={net.name}>
                  {net.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={
              !pendingPick || updateApplication.isPending || !primaryService
            }
            className="shrink-0"
          >
            <IconPlus className="mr-1 h-4 w-4" />
            Add network
          </Button>
        </div>

        {hasPending && (
          <p className="text-xs text-muted-foreground">
            Network changes take effect on the next redeploy — Stop, then Deploy
            this application to attach or detach them.
          </p>
        )}
      </CardContent>

      <ManagedNetworkDetailSheet
        network={selectedNetwork}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </Card>
  );
}
