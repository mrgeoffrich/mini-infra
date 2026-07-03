import { useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconPlus,
  IconTrash,
  IconPlugConnected,
} from "@tabler/icons-react";
import type { ContainerInfo, DockerNetwork } from "@mini-infra/types";
import { useContainers } from "@/hooks/useContainers";
import { useNetworks } from "@/hooks/use-networks";
import type { LinkedContainer } from "@/lib/application-schemas";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ConnectToContainersFieldProps {
  value: LinkedContainer[];
  onChange: (next: LinkedContainer[]) => void;
}

/**
 * Networks we never offer as an app-to-container link target:
 *  - the default `bridge` network (containers can't resolve each other by name)
 *  - `host` / `none` pseudo-networks (no shared bridge to join)
 *  - `null`/`host`-driver networks the daemon can't use for name DNS
 * Everything else is a user-defined bridge/overlay where Docker DNS lets the
 * app reach the target by its container name.
 */
function isUsableLinkNetwork(net: DockerNetwork): boolean {
  if (net.driver === "host" || net.driver === "null") return false;
  if (net.name === "host" || net.name === "none") return false;
  if (net.name === "bridge" && net.driver === "bridge") return false;
  return true;
}

/** Networks (usable for linking) that the given container is attached to. */
function candidateNetworksFor(
  containerName: string,
  networks: DockerNetwork[],
): DockerNetwork[] {
  return networks.filter(
    (net) =>
      isUsableLinkNetwork(net) &&
      net.containers.some((c) => c.name === containerName),
  );
}

/** The target container's IPv4 on a specific network, if known. */
function ipOnNetwork(
  containerName: string,
  networkName: string,
  networks: DockerNetwork[],
): string | undefined {
  const net = networks.find((n) => n.name === networkName);
  const entry = net?.containers.find((c) => c.name === containerName);
  const ip = entry?.ipv4Address;
  // Docker returns CIDR form (e.g. "172.20.0.3/16"); trim the mask for display.
  return ip ? ip.split("/")[0] : undefined;
}

/** Human-readable exposed ports for the read-only "connect here" hint. */
function portSummary(container: ContainerInfo | undefined): string {
  if (!container || container.ports.length === 0) return "no exposed ports";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of container.ports) {
    const label = `${p.private}/${p.type}`;
    if (!seen.has(label)) {
      seen.add(label);
      parts.push(label);
    }
  }
  return parts.join(", ");
}

export function ConnectToContainersField({
  value,
  onChange,
}: ConnectToContainersFieldProps) {
  const { data: containersData, isLoading: containersLoading } = useContainers({
    queryParams: { limit: 200 },
  });
  const { data: networksData } = useNetworks();

  const containers = useMemo(
    () => containersData?.containers ?? [],
    [containersData],
  );
  const networks = useMemo(() => networksData?.networks ?? [], [networksData]);

  const containerByName = useMemo(() => {
    const map = new Map<string, ContainerInfo>();
    for (const c of containers) map.set(c.name, c);
    return map;
  }, [containers]);

  // In-progress selection for the "add a link" row.
  const [pendingContainer, setPendingContainer] = useState("");
  const [pendingNetwork, setPendingNetwork] = useState("");

  // The durable unit of a link is its network — dedupe/exclude on that.
  const linkedNetworks = useMemo(
    () => new Set(value.map((l) => l.networkName)),
    [value],
  );

  // Usable networks for a pending container that aren't already linked.
  const freshCandidatesFor = useMemo(
    () => (containerName: string) =>
      candidateNetworksFor(containerName, networks).filter(
        (net) => !linkedNetworks.has(net.name),
      ),
    [networks, linkedNetworks],
  );

  // Containers offered by the picker: those with at least one usable network
  // not already linked (otherwise selecting them adds nothing).
  const selectableContainers = useMemo(
    () => containers.filter((c) => freshCandidatesFor(c.name).length > 0),
    [containers, freshCandidatesFor],
  );

  const pendingCandidates = useMemo(
    () => (pendingContainer ? freshCandidatesFor(pendingContainer) : []),
    [pendingContainer, freshCandidatesFor],
  );

  // The chosen container exists but has no joinable network left — surfaced as
  // guidance, not an error.
  const pendingUnreachable = !!pendingContainer && pendingCandidates.length === 0;

  const effectivePendingNetwork =
    pendingNetwork ||
    (pendingCandidates.length === 1 ? pendingCandidates[0].name : "");

  const handlePickContainer = (name: string) => {
    setPendingContainer(name);
    const candidates = freshCandidatesFor(name);
    // Auto-select when there's exactly one usable network.
    setPendingNetwork(candidates.length === 1 ? candidates[0].name : "");
  };

  const handleAdd = () => {
    if (!pendingContainer || !effectivePendingNetwork) return;
    onChange([
      ...value,
      { containerName: pendingContainer, networkName: effectivePendingNetwork },
    ]);
    setPendingContainer("");
    setPendingNetwork("");
  };

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconPlugConnected className="h-5 w-5" />
          Connect to a database or container
        </CardTitle>
        <CardDescription>
          Optionally attach this application to another running container&apos;s
          network — for example a database — so it can reach it by name. This is
          optional; leave it empty if the app doesn&apos;t need to talk to
          another container.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing links (durable unit = network; container label is best-effort) */}
        {value.length > 0 && (
          <div className="space-y-2">
            {value.map((link, index) => {
              const net = networks.find((n) => n.name === link.networkName);
              const members = net?.containers ?? [];
              // Prefer the stored container; else infer from the sole member.
              const target =
                link.containerName ??
                (members.length === 1 ? members[0].name : undefined);
              const container = target
                ? containerByName.get(target)
                : undefined;
              const ip = target
                ? ipOnNetwork(target, link.networkName, networks)
                : undefined;
              return (
                <div
                  key={`${link.networkName}:${link.containerName ?? ""}:${index}`}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="font-medium">
                      Joins network{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        {link.networkName}
                      </code>
                    </p>
                    {target ? (
                      <p className="text-muted-foreground">
                        Reach it at{" "}
                        <code className="rounded bg-muted px-1 py-0.5">
                          {target}
                        </code>
                        {ip ? ` (${ip})` : ""}
                        {container ? ` — ports: ${portSummary(container)}` : ""}
                        .
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        {members.length > 0
                          ? `Containers on this network: ${members
                              .map((m) => m.name)
                              .join(", ")}.`
                          : "No containers are currently attached to this network."}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemove(index)}
                    aria-label={`Remove connection to ${link.networkName}`}
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add-a-link row */}
        <div className="space-y-3 rounded-md border border-dashed p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Container</label>
              <Select
                value={pendingContainer}
                onValueChange={handlePickContainer}
                disabled={containersLoading}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      containersLoading
                        ? "Loading containers..."
                        : "Select a container"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {selectableContainers.map((c) => (
                    <SelectItem key={c.id} value={c.name}>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {c.image}
                          {c.imageTag ? `:${c.imageTag}` : ""}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                  {!containersLoading && selectableContainers.length === 0 && (
                    <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                      No connectable containers found.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Network picker: only when the container is on >1 usable network */}
            {pendingCandidates.length > 1 && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Network</label>
                <Select value={pendingNetwork} onValueChange={setPendingNetwork}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose which network" />
                  </SelectTrigger>
                  <SelectContent>
                    {pendingCandidates.map((net) => (
                      <SelectItem key={net.id} value={net.name}>
                        {net.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {pendingUnreachable && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-300">
              <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This container isn&apos;t on any user-defined network the app can
                join (it may only be on the default bridge, where containers
                can&apos;t resolve each other by name). Attach it to a
                user-defined network, or expose a published host port and connect
                via the host instead.
              </span>
            </div>
          )}

          {pendingContainer &&
            !pendingUnreachable &&
            effectivePendingNetwork && (
              <p className="text-sm text-muted-foreground">
                Your app will join{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  {effectivePendingNetwork}
                </code>{" "}
                and reach this container at{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  {pendingContainer}
                </code>
                {(() => {
                  const ip = ipOnNetwork(
                    pendingContainer,
                    effectivePendingNetwork,
                    networks,
                  );
                  return ip ? ` (${ip})` : "";
                })()}{" "}
                — ports: {portSummary(containerByName.get(pendingContainer))}.
              </p>
            )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={!pendingContainer || !effectivePendingNetwork}
          >
            <IconPlus className="mr-1 h-4 w-4" />
            Add connection
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
