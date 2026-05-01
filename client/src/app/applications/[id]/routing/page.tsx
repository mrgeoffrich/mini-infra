import { useMemo } from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  IconCloud,
  IconExternalLink,
  IconLink,
  IconNetwork,
  IconShieldCheck,
  IconWorld,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  StackInfo,
  StackServiceRouting,
} from "@mini-infra/types";
import type { ApplicationDetailContext } from "../layout";

interface ServiceWithRouting {
  serviceName: string;
  routing: StackServiceRouting;
}

function pickRoutedServices(
  stack: StackInfo | null,
): ServiceWithRouting[] {
  // Prefer the last-applied snapshot since it reflects what's actually running.
  // Fall back to the stack's current services so the tab is still useful when
  // the first apply failed (no snapshot yet) or services have been edited but
  // not yet applied.
  const fromSnapshot = stack?.lastAppliedSnapshot?.services;
  const fromStack = stack?.services;
  const source = fromSnapshot && fromSnapshot.length > 0 ? fromSnapshot : fromStack;
  if (!source) return [];
  const result: ServiceWithRouting[] = [];
  for (const s of source) {
    if (s.routing) {
      result.push({ serviceName: s.serviceName, routing: s.routing });
    }
  }
  return result;
}

function ChipLink({
  to,
  icon: Icon,
  label,
  value,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs",
        "hover:bg-muted transition-colors",
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium truncate">{value}</span>
    </Link>
  );
}

function RoutingCard({
  serviceName,
  routing,
  stack,
}: {
  serviceName: string;
  routing: StackServiceRouting;
  stack: StackInfo;
}) {
  const tlsCert = routing.tlsCertificate
    ? stack.tlsCertificates.find((c) => c.name === routing.tlsCertificate)
    : undefined;
  const dnsRecord = routing.dnsRecord
    ? stack.dnsRecords.find((d) => d.name === routing.dnsRecord)
    : undefined;
  const tunnel = routing.tunnelIngress
    ? stack.tunnelIngress.find((t) => t.name === routing.tunnelIngress)
    : undefined;
  const backendName = `stk-${stack.name}-${serviceName}`;
  const url = `https://${routing.hostname}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconWorld className="h-4 w-4 text-muted-foreground" />
              {serviceName}
            </CardTitle>
            <CardDescription className="font-mono mt-1">
              {routing.hostname} → :{String(routing.listeningPort)}
              {routing.healthCheckEndpoint && (
                <span className="ml-2 text-xs">
                  health: {routing.healthCheckEndpoint}
                </span>
              )}
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <IconExternalLink className="h-4 w-4 mr-1" />
              Open
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {tlsCert && (
            <ChipLink
              to="/certificates"
              icon={IconShieldCheck}
              label="TLS"
              value={tlsCert.fqdn}
            />
          )}
          {dnsRecord && (
            <ChipLink
              to="/dns"
              icon={IconNetwork}
              label="DNS"
              value={dnsRecord.fqdn}
            />
          )}
          {tunnel && (
            <ChipLink
              to="/tunnels"
              icon={IconCloud}
              label="Tunnel"
              value={tunnel.fqdn}
            />
          )}
          <ChipLink
            to={`/haproxy/backends/${encodeURIComponent(backendName)}`}
            icon={IconLink}
            label="Backend"
            value={backendName}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function ApplicationRoutingTab() {
  const { primaryStack } = useOutletContext<ApplicationDetailContext>();
  const routedServices = useMemo(
    () => pickRoutedServices(primaryStack),
    [primaryStack],
  );

  if (!primaryStack) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Routing</CardTitle>
          <CardDescription>
            Routing will appear here once this application is deployed.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const networks = primaryStack.networks ?? [];
  const volumes = primaryStack.volumes ?? [];

  return (
    <div className="grid gap-6 max-w-4xl">
      {routedServices.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Routing</CardTitle>
            <CardDescription>
              No services in this application expose a public hostname.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        routedServices.map(({ serviceName, routing }) => (
          <RoutingCard
            key={serviceName}
            serviceName={serviceName}
            routing={routing}
            stack={primaryStack}
          />
        ))
      )}

      {(networks.length > 0 || volumes.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Networks &amp; volumes</CardTitle>
            <CardDescription>
              Docker networks and volumes provisioned by this stack.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {networks.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Networks ({networks.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {networks.map((n) => (
                    <Badge key={n.name} variant="outline" className="font-mono">
                      {n.name}
                      {n.driver && (
                        <span className="ml-1 text-muted-foreground">
                          ({n.driver})
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {volumes.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Volumes ({volumes.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {volumes.map((v) => (
                    <Link
                      key={v.name}
                      to={`/containers/volumes/${encodeURIComponent(v.name)}/inspect`}
                      className="inline-flex items-center rounded-md border bg-card px-2 py-1 text-xs font-mono hover:bg-muted transition-colors"
                    >
                      {v.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
