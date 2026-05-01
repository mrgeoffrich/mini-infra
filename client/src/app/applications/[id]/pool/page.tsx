import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PoolServiceRow } from "@/components/stacks/PoolServiceRow";
import type { StackServiceInfo } from "@mini-infra/types";
import type { ApplicationDetailContext } from "../layout";

export default function ApplicationPoolTab() {
  const { primaryStack } = useOutletContext<ApplicationDetailContext>();
  const poolServices = useMemo<StackServiceInfo[]>(() => {
    return (primaryStack?.services ?? []).filter(
      (s) => s.serviceType === "Pool",
    );
  }, [primaryStack]);

  if (!primaryStack) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pool</CardTitle>
          <CardDescription>
            Pool instances will appear here once this application is deployed.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (poolServices.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pool</CardTitle>
          <CardDescription>
            This application has no pool services.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Pool services are container blueprints that spin up instances on
            demand. Add a service of type <code>Pool</code> to use this tab.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pool services</CardTitle>
        <CardDescription>
          Expand a row to see active instances. Pool instances are managed by
          their caller service via the pool API.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {poolServices.map((service) => (
          <PoolServiceRow
            key={service.id}
            stackId={primaryStack.id}
            service={service}
          />
        ))}
      </CardContent>
    </Card>
  );
}
