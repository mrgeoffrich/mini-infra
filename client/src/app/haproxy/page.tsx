import { useNavigate } from "react-router-dom";
import {
  IconNetwork,
  IconArrowRight,
  IconServer2,
  IconShield,
  IconRoute,
} from "@tabler/icons-react";
import { useAllFrontends } from "@/hooks/use-haproxy-frontend";
import { useAllBackends } from "@/hooks/use-haproxy-backends";
import { useEnvironments } from "@/hooks/use-environments";
import { useHAProxyStatus } from "@/hooks/use-haproxy-remediation";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Environment } from "@mini-infra/types";

const MAX_ITEMS = 5;

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : "bg-yellow-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function InstanceRow({ environment }: { environment: Environment }) {
  const { data } = useHAProxyStatus(environment.id);
  const status = data?.data;

  if (!status?.hasHAProxy) return null;

  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status="active" />
        <span className="text-sm truncate">{environment.name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status.sharedFrontendsCount != null && (
          <Badge variant="outline" className="text-xs">
            {(status.sharedFrontendsCount ?? 0) + (status.manualFrontendsCount ?? 0)} frontends
          </Badge>
        )}
        {status.totalRoutesCount != null && (
          <Badge variant="outline" className="text-xs">
            {status.totalRoutesCount} routes
          </Badge>
        )}
      </div>
    </div>
  );
}

export default function HAProxyOverviewPage() {
  const navigate = useNavigate();
  const { data: frontendData, isLoading: loadingFrontends } = useAllFrontends();
  const { data: backendData, isLoading: loadingBackends } = useAllBackends();
  const { data: envData, isLoading: loadingEnvs } = useEnvironments();

  const frontends = frontendData?.data ?? [];
  const backends = backendData?.data ?? [];
  const environments = envData?.environments ?? [];

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconNetwork className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold">Load Balancer</h1>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Frontends Card */}
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate("/haproxy/frontends")}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <IconShield className="h-4 w-4 text-muted-foreground" />
                  Frontends
                </CardTitle>
                <div className="flex items-center gap-1 text-muted-foreground">
                  {!loadingFrontends && (
                    <Badge variant="secondary">{frontends.length}</Badge>
                  )}
                  <IconArrowRight className="h-4 w-4" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {loadingFrontends ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : frontends.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No frontends configured
                </p>
              ) : (
                <div className="divide-y">
                  {frontends.slice(0, MAX_ITEMS).map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center justify-between py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusDot status={f.status} />
                        <span className="text-sm font-mono truncate">
                          {f.frontendName}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {f.useSSL && (
                          <Badge variant="outline" className="text-xs">
                            SSL
                          </Badge>
                        )}
                        {(f.routesCount ?? 0) > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {f.routesCount} {f.routesCount === 1 ? "route" : "routes"}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                  {frontends.length > MAX_ITEMS && (
                    <p className="text-xs text-muted-foreground pt-2">
                      +{frontends.length - MAX_ITEMS} more
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Backends Card */}
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate("/haproxy/backends")}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <IconServer2 className="h-4 w-4 text-muted-foreground" />
                  Backends
                </CardTitle>
                <div className="flex items-center gap-1 text-muted-foreground">
                  {!loadingBackends && (
                    <Badge variant="secondary">{backends.length}</Badge>
                  )}
                  <IconArrowRight className="h-4 w-4" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {loadingBackends ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : backends.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No backends configured
                </p>
              ) : (
                <div className="divide-y">
                  {backends.slice(0, MAX_ITEMS).map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusDot status={b.status} />
                        <span className="text-sm font-mono truncate">
                          {b.name}
                        </span>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {b.serversCount} {b.serversCount === 1 ? "server" : "servers"}
                      </Badge>
                    </div>
                  ))}
                  {backends.length > MAX_ITEMS && (
                    <p className="text-xs text-muted-foreground pt-2">
                      +{backends.length - MAX_ITEMS} more
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Instances Card */}
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate("/haproxy/instances")}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <IconRoute className="h-4 w-4 text-muted-foreground" />
                  Instances
                </CardTitle>
                <div className="flex items-center gap-1 text-muted-foreground">
                  {!loadingEnvs && (
                    <Badge variant="secondary">{environments.length}</Badge>
                  )}
                  <IconArrowRight className="h-4 w-4" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {loadingEnvs ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : environments.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No environments configured
                </p>
              ) : (
                <div className="divide-y">
                  {environments.slice(0, MAX_ITEMS).map((env) => (
                    <InstanceRow key={env.id} environment={env} />
                  ))}
                  {environments.length > MAX_ITEMS && (
                    <p className="text-xs text-muted-foreground pt-2">
                      +{environments.length - MAX_ITEMS} more
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
