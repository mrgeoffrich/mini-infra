import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PoolServiceRow } from "@/components/stacks/PoolServiceRow";
import type {
  Environment,
  StackInfo,
  StackServiceInfo,
} from "@mini-infra/types";

/**
 * Pool services for a deployed stack, extracted from the former standalone Pool
 * tab. Renders nothing when the stack has no `Pool`-type services, so it only
 * appears on the Services tab for apps that actually use pools.
 */
export function PoolSection({
  stack,
  environment,
}: {
  stack: StackInfo;
  environment: Environment | undefined;
}) {
  const poolServices = useMemo<StackServiceInfo[]>(
    () => (stack.services ?? []).filter((s) => s.serviceType === "Pool"),
    [stack.services],
  );

  if (poolServices.length === 0) return null;

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
            stackId={stack.id}
            service={service}
            stackName={stack.name}
            envName={environment?.name}
          />
        ))}
      </CardContent>
    </Card>
  );
}
