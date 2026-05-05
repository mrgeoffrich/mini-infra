import { Fragment, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconDatabase,
  IconEye,
  IconEyeOff,
  IconPlugConnected,
  IconUsersGroup,
  IconWorld,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AddonBadge } from "@/components/stacks/addon-badge";
import type {
  StackContainerStatus,
  StackServiceDefinition,
  StackServiceType,
} from "@mini-infra/types";

interface ServiceRowProps {
  service: StackServiceDefinition;
  containers: StackContainerStatus[];
}

function ServiceTypeBadge({ type }: { type: StackServiceType }) {
  const Icon =
    type === "Stateful"
      ? IconDatabase
      : type === "StatelessWeb"
        ? IconWorld
        : type === "Pool"
          ? IconUsersGroup
          : IconPlugConnected;
  return (
    <Badge variant="outline" className="gap-1">
      <Icon className="h-3 w-3" />
      {type}
    </Badge>
  );
}

function summarisePorts(service: StackServiceDefinition): string {
  const ports = service.containerConfig?.ports ?? [];
  if (ports.length === 0) return "—";
  return ports
    .map((p) => `${p.hostPort}:${p.containerPort}/${p.protocol}`)
    .join(", ");
}

function formatStatusValue(running: number, total: number): string {
  if (total === 0) return "—";
  return `${running}/${total} up`;
}

function formatStatusTone(running: number, total: number): string {
  if (total === 0) return "text-muted-foreground";
  if (running === total) return "text-emerald-600 dark:text-emerald-400";
  if (running === 0) return "text-destructive";
  return "text-amber-600 dark:text-amber-400";
}

export function ServiceRow({ service, containers }: ServiceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showEnvValues, setShowEnvValues] = useState(false);
  const total = containers.length;
  const running = containers.filter((c) => c.state === "running").length;
  const env = service.containerConfig?.env ?? {};
  const mounts = service.containerConfig?.mounts ?? [];
  const hc = service.containerConfig?.healthcheck;
  const restartPolicy = service.containerConfig?.restartPolicy ?? "—";
  const dependsOn = service.dependsOn ?? [];
  const envEntries = Object.entries(env);
  const synthetic = service.synthetic;
  // The first addon id is the canonical badge label. For merged groups
  // (`kind: tailscale` collapsing `tailscale-ssh` + `tailscale-web` into
  // one sidecar) `kind` is the better label; fall back to the first id
  // when no kind is set.
  const addonLabel = synthetic
    ? synthetic.kind ?? synthetic.addonIds[0]
    : undefined;

  return (
    <Fragment>
      <TableRow>
        <TableCell className="w-8 align-top">
          {!synthetic && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <IconChevronDown className="h-4 w-4" />
              ) : (
                <IconChevronRight className="h-4 w-4" />
              )}
            </Button>
          )}
        </TableCell>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            <span>{service.serviceName}</span>
            {synthetic && addonLabel && (
              <AddonBadge
                addonName={addonLabel}
                targetName={synthetic.targetService}
              />
            )}
          </div>
        </TableCell>
        <TableCell>
          <ServiceTypeBadge type={service.serviceType} />
        </TableCell>
        <TableCell className="font-mono text-xs">
          {service.dockerImage}:{service.dockerTag}
        </TableCell>
        <TableCell className={cn("text-sm", formatStatusTone(running, total))}>
          {formatStatusValue(running, total)}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {summarisePorts(service)}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30">
            <div className="grid gap-4 md:grid-cols-2 py-2">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Containers
                </div>
                {containers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No running containers found.
                  </p>
                ) : (
                  <ul className="text-xs space-y-1">
                    {containers.map((c) => (
                      <li key={c.containerId} className="flex gap-2">
                        <span
                          className={cn(
                            "font-mono",
                            c.state === "running"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {c.state}
                        </span>
                        <span className="text-muted-foreground truncate">
                          {c.containerName}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Runtime
                </div>
                <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                  <dt className="text-muted-foreground">Restart policy</dt>
                  <dd>{restartPolicy}</dd>
                  {hc && (
                    <>
                      <dt className="text-muted-foreground">Healthcheck</dt>
                      <dd className="font-mono truncate">
                        {Array.isArray(hc.test) ? hc.test.join(" ") : hc.test}
                      </dd>
                    </>
                  )}
                  {dependsOn.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Depends on</dt>
                      <dd>{dependsOn.join(", ")}</dd>
                    </>
                  )}
                </dl>
              </div>

              {envEntries.length > 0 && (
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs font-medium text-muted-foreground">
                      Environment ({envEntries.length})
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => setShowEnvValues((v) => !v)}
                    >
                      {showEnvValues ? (
                        <IconEyeOff className="h-3 w-3 mr-1" />
                      ) : (
                        <IconEye className="h-3 w-3 mr-1" />
                      )}
                      {showEnvValues ? "Hide values" : "Show values"}
                    </Button>
                  </div>
                  <ul className="text-xs font-mono grid gap-0.5">
                    {envEntries.map(([key, value]) => (
                      <li key={key} className="truncate">
                        <span className="text-muted-foreground">{key}=</span>
                        <span>{showEnvValues ? value : "••••••"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {mounts.length > 0 && (
                <div className="md:col-span-2">
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Mounts ({mounts.length})
                  </div>
                  <ul className="text-xs font-mono grid gap-0.5">
                    {mounts.map((m, i) => (
                      <li key={`${m.source}-${m.target}-${i}`}>
                        <span className="text-muted-foreground">
                          {m.type}:
                        </span>{" "}
                        {m.source} → {m.target}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
