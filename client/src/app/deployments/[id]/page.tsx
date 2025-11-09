import { useParams, useNavigate } from "react-router-dom";
import { IconArrowLeft, IconRefresh, IconTrash, IconGlobe, IconServer } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useDeploymentConfig } from "@/hooks/use-deployment-configs";
import { useDeploymentDNS, useSyncDeploymentDNS, useDeleteDeploymentDNS } from "@/hooks/use-deployment-dns";
import { useDeploymentFrontend, useSyncDeploymentFrontend } from "@/hooks/use-haproxy-frontend";
import { useEnvironments } from "@/hooks/use-environments";
import { DNSStatusBadge } from "@/components/deployments/dns-status-badge";
import { FrontendConfigCard, EmptyState } from "@/components/deployments/frontend-config-card";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { toast } from "sonner";
import { useState } from "react";

export function DeploymentConfigDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();
  const [deletingDNSId, setDeletingDNSId] = useState<string | null>(null);

  // Fetch deployment configuration
  const {
    data: configResponse,
    isLoading: isLoadingConfig,
    error: configError,
  } = useDeploymentConfig(id || "", {
    enabled: !!id,
  });

  // Fetch DNS records
  const {
    data: dnsResponse,
    isLoading: isLoadingDNS,
    error: dnsError,
  } = useDeploymentDNS(id || "", {
    enabled: !!id,
  });

  // Fetch HAProxy frontend
  const {
    data: frontendResponse,
    isLoading: isLoadingFrontend,
    error: frontendError,
  } = useDeploymentFrontend(id || "", {
    enabled: !!id,
  });

  // Fetch environments
  const { data: environmentsResponse } = useEnvironments({
    filters: { limit: 100 },
  });

  // Mutations
  const syncDNSMutation = useSyncDeploymentDNS();
  const deleteDNSMutation = useDeleteDeploymentDNS();
  const syncFrontendMutation = useSyncDeploymentFrontend();

  const config = configResponse?.data;
  const dnsRecords = dnsResponse?.data || [];
  const frontend = frontendResponse?.data;
  const environment = environmentsResponse?.environments?.find(
    (env) => env.id === config?.environmentId
  );

  const handleBack = () => {
    navigate("/deployments");
  };

  const handleSyncDNS = async () => {
    if (!id) return;
    try {
      await syncDNSMutation.mutateAsync(id);
      toast.success("DNS record synced successfully");
    } catch (error) {
      toast.error(
        `Failed to sync DNS: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const handleDeleteDNS = async (recordId: string) => {
    if (!id) return;
    setDeletingDNSId(recordId);
    try {
      await deleteDNSMutation.mutateAsync(id);
      toast.success("DNS record deleted successfully");
    } catch (error) {
      toast.error(
        `Failed to delete DNS: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } finally {
      setDeletingDNSId(null);
    }
  };

  const handleSyncFrontend = async () => {
    if (!id) return;
    try {
      await syncFrontendMutation.mutateAsync(id);
      toast.success("Frontend configuration synced successfully");
    } catch (error) {
      toast.error(
        `Failed to sync frontend: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  if (configError) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground">Failed to load deployment configuration</p>
            <p className="text-sm text-destructive mt-2">
              {configError instanceof Error ? configError.message : "Unknown error"}
            </p>
            <Button onClick={handleBack} className="mt-4">
              <IconArrowLeft className="mr-2 h-4 w-4" />
              Back to Deployments
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoadingConfig) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground">Deployment configuration not found</p>
            <Button onClick={handleBack} className="mt-4">
              <IconArrowLeft className="mr-2 h-4 w-4" />
              Back to Deployments
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <Button onClick={handleBack} variant="ghost" size="sm">
          <IconArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight">{config.applicationName}</h1>
          <p className="text-muted-foreground font-mono">{config.dockerImage}</p>
        </div>
        <Badge variant={config.isActive ? "default" : "secondary"}>
          {config.isActive ? "Active" : "Inactive"}
        </Badge>
      </div>

      {/* Configuration Details */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Application Name</p>
              <p className="font-medium">{config.applicationName}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Docker Image</p>
              <p className="font-medium font-mono">{config.dockerImage}</p>
            </div>
            {environment && (
              <div>
                <p className="text-sm text-muted-foreground">Environment</p>
                <Badge variant={environment.type === 'production' ? 'destructive' : 'secondary'}>
                  {environment.name}
                </Badge>
              </div>
            )}
            {config.hostname && (
              <div>
                <p className="text-sm text-muted-foreground">Hostname</p>
                <p className="font-medium">{config.hostname}</p>
              </div>
            )}
            {config.listeningPort && (
              <div>
                <p className="text-sm text-muted-foreground">Listening Port</p>
                <p className="font-medium">{config.listeningPort}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground">Created At</p>
              <p className="font-medium">{formatDateTime(config.createdAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* DNS Configuration Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconGlobe className="h-5 w-5" />
              <CardTitle>DNS Configuration</CardTitle>
            </div>
            {dnsRecords.length > 0 && (
              <Button
                onClick={handleSyncDNS}
                variant="outline"
                size="sm"
                disabled={syncDNSMutation.isPending}
              >
                {syncDNSMutation.isPending ? (
                  <>
                    <IconRefresh className="mr-2 h-4 w-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <IconRefresh className="mr-2 h-4 w-4" />
                    Sync DNS
                  </>
                )}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingDNS ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : dnsError ? (
            <div className="text-sm text-destructive">
              Failed to load DNS records: {dnsError instanceof Error ? dnsError.message : "Unknown error"}
            </div>
          ) : dnsRecords.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated At</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dnsRecords.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium">{record.hostname}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {record.dnsProvider === 'cloudflare' ? 'CloudFlare' : 'External'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {record.ipAddress || 'N/A'}
                    </TableCell>
                    <TableCell>
                      <DNSStatusBadge status={record.status} variant="compact" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(record.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        onClick={() => handleDeleteDNS(record.id)}
                        variant="ghost"
                        size="sm"
                        disabled={deletingDNSId === record.id}
                      >
                        {deletingDNSId === record.id ? (
                          <IconRefresh className="h-4 w-4 animate-spin" />
                        ) : (
                          <IconTrash className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              message="No DNS records configured"
              description="DNS records will be created automatically when you deploy this configuration"
            />
          )}
        </CardContent>
      </Card>

      {/* HAProxy Frontend Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <IconServer className="h-5 w-5" />
          <h2 className="text-xl font-semibold">HAProxy Frontend</h2>
        </div>
        {isLoadingFrontend ? (
          <Skeleton className="h-64 w-full" />
        ) : frontendError ? (
          <Card>
            <CardContent className="py-8">
              <div className="text-sm text-destructive text-center">
                Failed to load frontend configuration
              </div>
            </CardContent>
          </Card>
        ) : frontend ? (
          <FrontendConfigCard
            frontend={frontend}
            onSync={handleSyncFrontend}
            isSyncing={syncFrontendMutation.isPending}
          />
        ) : (
          <Card>
            <CardContent className="py-8">
              <EmptyState
                message="No HAProxy frontend configured"
                description="A frontend will be created automatically when you deploy this configuration"
              />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default DeploymentConfigDetailsPage;
