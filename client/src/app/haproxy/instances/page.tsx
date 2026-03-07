import { useState } from "react";
import { Link } from "react-router-dom";
import {
  IconServer2,
  IconRefresh,
  IconAlertTriangle,
  IconCircleCheck,
  IconNetwork,
} from "@tabler/icons-react";

import { useEnvironments } from "@/hooks/use-environments";
import { useHAProxyStatus, useMigrationPreview } from "@/hooks/use-haproxy-remediation";
import { RemediateHAProxyDialog } from "@/components/haproxy/remediate-haproxy-dialog";
import { MigrateHAProxyDialog } from "@/components/haproxy/migrate-haproxy-dialog";
import { EnvironmentStatus } from "@/components/environments/environment-status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Environment } from "@mini-infra/types";

function EnvironmentTypeBadge({ type }: { type: string }) {
  if (type === "production") {
    return (
      <Badge
        variant="outline"
        className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950"
      >
        Production
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-300 dark:border-blue-800 dark:bg-blue-950"
    >
      Staging
    </Badge>
  );
}

function HAProxyHealthBadge({
  needsRemediation,
  isLoading,
  isError,
}: {
  needsRemediation: boolean | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-5 w-28" />;
  }
  if (isError) {
    return (
      <Badge
        variant="outline"
        className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950"
      >
        <IconAlertTriangle className="h-3 w-3 mr-1" />
        Unavailable
      </Badge>
    );
  }
  if (needsRemediation) {
    return (
      <Badge
        variant="outline"
        className="text-yellow-700 border-yellow-200 bg-yellow-50 dark:text-yellow-300 dark:border-yellow-800 dark:bg-yellow-950"
      >
        <IconAlertTriangle className="h-3 w-3 mr-1" />
        Needs Remediation
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
    >
      <IconCircleCheck className="h-3 w-3 mr-1" />
      Healthy
    </Badge>
  );
}

function HAProxyInstanceRow({ env }: { env: Environment }) {
  const [remediateOpen, setRemediateOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const { data, isLoading, isError } = useHAProxyStatus(env.id);

  const isStopped = env.status === "stopped";
  const status = data?.data;

  // Check if this environment needs migration from legacy to stack-managed
  const { data: migrationPreview } = useMigrationPreview(env.id, {
    enabled: !isStopped,
  });
  const needsMigration = migrationPreview?.data?.needsMigration ?? false;

  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/environments/${env.id}`}
          className="font-medium hover:underline text-foreground"
        >
          {env.name}
        </Link>
      </TableCell>
      <TableCell>
        <EnvironmentTypeBadge type={env.type} />
      </TableCell>
      <TableCell>
        <EnvironmentStatus status={env.status} />
      </TableCell>
      <TableCell>
        {isStopped ? (
          <span className="text-muted-foreground">—</span>
        ) : needsMigration ? (
          <Badge
            variant="outline"
            className="text-orange-700 border-orange-200 bg-orange-50 dark:text-orange-300 dark:border-orange-800 dark:bg-orange-950"
          >
            <IconAlertTriangle className="h-3 w-3 mr-1" />
            Legacy
          </Badge>
        ) : (
          <HAProxyHealthBadge
            needsRemediation={status?.needsRemediation}
            isLoading={isLoading}
            isError={isError}
          />
        )}
      </TableCell>
      <TableCell>
        {isStopped ? (
          <span className="text-muted-foreground">—</span>
        ) : isLoading ? (
          <Skeleton className="h-4 w-6" />
        ) : isError ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>{status?.sharedFrontendsCount ?? 0}</span>
        )}
      </TableCell>
      <TableCell>
        {isStopped ? (
          <span className="text-muted-foreground">—</span>
        ) : isLoading ? (
          <Skeleton className="h-4 w-6" />
        ) : isError ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>{status?.totalRoutesCount ?? 0}</span>
        )}
      </TableCell>
      <TableCell>
        {needsMigration ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={isStopped}
              onClick={() => setMigrateOpen(true)}
              className="text-orange-700 border-orange-200 hover:bg-orange-50 dark:text-orange-300 dark:border-orange-800 dark:hover:bg-orange-950"
            >
              Migrate to Stack
            </Button>
            <MigrateHAProxyDialog
              environmentId={env.id}
              environmentName={env.name}
              open={migrateOpen}
              onOpenChange={setMigrateOpen}
            />
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={isStopped}
              onClick={() => setRemediateOpen(true)}
            >
              Remediate
            </Button>
            <RemediateHAProxyDialog
              environmentId={env.id}
              environmentName={env.name}
              open={remediateOpen}
              onOpenChange={setRemediateOpen}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function HAProxyInstancesPage() {
  const { data, isLoading, refetch, isRefetching } = useEnvironments();

  const environments = data?.environments ?? [];
  const haproxyEnvironments = environments.filter((env) =>
    env.services.some((s) => s.serviceName === "haproxy")
  );

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconServer2 className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">HAProxy Instances</h1>
              <p className="text-sm text-muted-foreground">
                Health status and remediation for all HAProxy-enabled environments
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading || isRefetching}
          >
            <IconRefresh className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="px-4 lg:px-6">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : haproxyEnvironments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="p-4 rounded-full bg-muted">
              <IconNetwork className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No HAProxy environments found</p>
              <p className="text-sm text-muted-foreground mt-1">
                Environments with HAProxy configured will appear here.{" "}
                <Link to="/environments" className="underline hover:text-foreground">
                  View all environments
                </Link>
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Environment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Env Status</TableHead>
                  <TableHead>HAProxy Health</TableHead>
                  <TableHead>Frontends</TableHead>
                  <TableHead>Routes</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {haproxyEnvironments.map((env) => (
                  <HAProxyInstanceRow key={env.id} env={env} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
