import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  StackContainerStatus,
  StackServiceDefinition,
} from "@mini-infra/types";
import { ServiceRow } from "../_components/service-row";
import type { ApplicationDetailContext } from "../layout";

function groupContainersByService(
  status: StackContainerStatus[],
): Map<string, StackContainerStatus[]> {
  const map = new Map<string, StackContainerStatus[]>();
  for (const c of status) {
    const list = map.get(c.serviceName) ?? [];
    list.push(c);
    map.set(c.serviceName, list);
  }
  return map;
}

function getServices(
  ctx: ApplicationDetailContext,
): StackServiceDefinition[] {
  const fromSnapshot = ctx.primaryStack?.lastAppliedSnapshot?.services;
  if (fromSnapshot && fromSnapshot.length > 0) return fromSnapshot;

  // Fallback: render the template's draft/current services so the tab is
  // useful even before the first apply. Map them to the definition shape.
  const version =
    ctx.template.currentVersion ?? ctx.template.draftVersion ?? null;
  if (!version?.services) return [];
  return version.services.map((s) => ({
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig,
    initCommands: s.initCommands ?? undefined,
    dependsOn: s.dependsOn ?? [],
    order: s.order,
    routing: s.routing ?? undefined,
    adoptedContainer: s.adoptedContainer ?? undefined,
    poolConfig: s.poolConfig ?? undefined,
  }));
}

export default function ApplicationServicesTab() {
  const ctx = useOutletContext<ApplicationDetailContext>();
  const services = useMemo(() => getServices(ctx), [ctx]);
  const containersByService = useMemo(
    () => groupContainersByService(ctx.containerStatus),
    [ctx.containerStatus],
  );

  if (services.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>
            This application has no services defined.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
        <CardDescription>
          Services declared by this application. Expand a row for runtime
          details.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Image</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ports</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((service) => (
              <ServiceRow
                key={service.serviceName}
                service={service}
                containers={containersByService.get(service.serviceName) ?? []}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
