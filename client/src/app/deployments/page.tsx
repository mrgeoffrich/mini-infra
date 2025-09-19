import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconLayoutGrid,
  IconList,
  IconPlus,
} from "@tabler/icons-react";

import { DeploymentList } from "@/components/deployments/deployment-list";
import { DeploymentCard } from "@/components/deployments/deployment-card";
import { DeleteDeploymentConfigDialog } from "@/components/deployments/delete-deployment-config-dialog";
import { useDeploymentConfigs, useDeploymentConfigFilters } from "@/hooks/use-deployment-configs";
import { useActiveDeployments, useLatestDeployments } from "@/hooks/use-deployment-history";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DeploymentConfigurationInfo, DeploymentInfo } from "@mini-infra/types";

export function DeploymentsPage() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [configToDelete, setConfigToDelete] = useState<DeploymentConfigurationInfo | null>(null);
  const { filters } = useDeploymentConfigFilters();
  
  // Fetch deployment configurations
  const {
    data: configsResponse,
    isLoading: isLoadingConfigs,
    error: configsError,
  } = useDeploymentConfigs({
    filters: {
      applicationName: filters.applicationName,
      dockerImage: filters.dockerImage,
      isActive: filters.isActive,
    },
    page: 1,
    limit: 50, // Get more for card view
    sortBy: "applicationName",
    sortOrder: "asc",
    refetchInterval: 30000,
  });

  // Fetch active deployments for real-time updates
  const {
    data: activeDeploymentsResponse,
  } = useActiveDeployments({
    refetchInterval: 5000,
  });

  // Fetch latest deployments for all configurations (including completed ones)
  const {
    data: latestDeploymentsResponse,
  } = useLatestDeployments({
    refetchInterval: 15000,
  });

  // Fetch environments for displaying environment names
  const {
    data: environmentsResponse,
  } = useEnvironments({
    filters: { limit: 100 },
  });

  const configs = configsResponse?.data || [];
  const environments = environmentsResponse?.environments || [];

  // Create a map of environments by ID
  const environmentsById = useMemo(() => {
    const map = new Map();
    environments.forEach(env => {
      map.set(env.id, env);
    });
    return map;
  }, [environments]);

  // Create a map of latest deployments by configuration
  // Combine active deployments (for real-time updates) with latest deployments (for completed status)
  const latestDeploymentsByConfig = useMemo(() => {
    const map = new Map<string, DeploymentInfo>();
    
    // First add all latest deployments (including completed/failed ones)
    (latestDeploymentsResponse?.data || []).forEach((deployment) => {
      map.set(deployment.configurationId, deployment);
    });
    
    // Then overlay active deployments for real-time updates
    (activeDeploymentsResponse?.data || []).forEach((deployment) => {
      const existing = map.get(deployment.configurationId);
      if (!existing || new Date(deployment.startedAt) > new Date(existing.startedAt)) {
        map.set(deployment.configurationId, deployment);
      }
    });
    
    return map;
  }, [activeDeploymentsResponse?.data, latestDeploymentsResponse?.data]);

  const handleEditConfig = useCallback((config: DeploymentConfigurationInfo) => {
    navigate(`/deployments/new?edit=${config.id}`);
  }, [navigate]);

  const handleDeleteConfig = useCallback((config: DeploymentConfigurationInfo) => {
    setConfigToDelete(config);
    setDeleteDialogOpen(true);
  }, []);

  const handleCloseDeleteDialog = useCallback(() => {
    setDeleteDialogOpen(false);
    setConfigToDelete(null);
  }, []);

  const handleCreateConfig = useCallback(() => {
    navigate("/deployments/new");
  }, [navigate]);

  if (configsError) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground">Failed to load deployment configurations</p>
            <p className="text-sm text-destructive mt-2">
              {configsError instanceof Error ? configsError.message : "Unknown error"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Deployments</h1>
          <p className="text-muted-foreground">
            Manage your application deployment configurations and monitor deployment status.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as "list" | "cards")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="list" className="flex items-center gap-2">
                <IconList className="h-4 w-4" />
                List
              </TabsTrigger>
              <TabsTrigger value="cards" className="flex items-center gap-2">
                <IconLayoutGrid className="h-4 w-4" />
                Cards
              </TabsTrigger>
            </TabsList>
          </Tabs>
          
          <Button onClick={handleCreateConfig}>
            <IconPlus className="h-4 w-4 mr-2" />
            New Configuration
          </Button>
        </div>
      </div>

      {/* Content */}
      {viewMode === "list" ? (
        <DeploymentList
          onEditConfig={handleEditConfig}
          onDeleteConfig={handleDeleteConfig}
          onCreateConfig={handleCreateConfig}
        />
      ) : (
        <div className="space-y-6">
          {/* Cards View */}
          {isLoadingConfigs && configs.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-64 w-full" />
              ))}
            </div>
          ) : configs.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {configs.map((config) => (
                <DeploymentCard
                  key={config.id}
                  config={config}
                  latestDeployment={latestDeploymentsByConfig.get(config.id)}
                  environment={environmentsById.get(config.environmentId)}
                  onEdit={handleEditConfig}
                  onDelete={handleDeleteConfig}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="mx-auto max-w-md">
                <IconLayoutGrid className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-semibold">No deployment configurations</h3>
                <p className="mt-2 text-muted-foreground">
                  Get started by creating your first deployment configuration.
                </p>
                <Button onClick={handleCreateConfig} className="mt-4">
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create Configuration
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <DeleteDeploymentConfigDialog
        config={configToDelete}
        isOpen={deleteDialogOpen}
        onClose={handleCloseDeleteDialog}
      />
    </div>
  );
}

export default DeploymentsPage;