import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconRocket,
  IconAlertCircle,
} from "@tabler/icons-react";

import { DeploymentList } from "@/components/deployments/deployment-list";
import { DeploymentCard } from "@/components/deployments/deployment-card";
import { UninstallDeploymentConfigDialog } from "@/components/deployments/uninstall-deployment-config-dialog";
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
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [configToUninstall, setConfigToUninstall] = useState<DeploymentConfigurationInfo | null>(null);
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

  const handleUninstallConfig = useCallback((config: DeploymentConfigurationInfo) => {
    setConfigToUninstall(config);
    setUninstallDialogOpen(true);
  }, []);

  const handleCloseUninstallDialog = useCallback(() => {
    setUninstallDialogOpen(false);
    setConfigToUninstall(null);
  }, []);

  const handleCreateConfig = useCallback(() => {
    navigate("/deployments/new");
  }, [navigate]);

  if (configsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconRocket className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Deployments</h1>
              <p className="text-muted-foreground">
                Manage your application deployment configurations and monitor deployment status.
              </p>
            </div>
          </div>

          <div className="mt-6 p-4 border border-destructive/50 bg-destructive/10 rounded-md flex items-start gap-3">
            <IconAlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Failed to load deployment configurations</p>
              <p className="text-sm text-muted-foreground mt-1">
                {configsError instanceof Error ? configsError.message : "Unknown error"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Page Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconRocket className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Deployments</h1>
              <p className="text-muted-foreground">
                Manage your application deployment configurations and monitor deployment status.
              </p>
            </div>
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
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6">
        {viewMode === "list" ? (
          <DeploymentList
            onEditConfig={handleEditConfig}
            onUninstallConfig={handleUninstallConfig}
            onCreateConfig={handleCreateConfig}
          />
        ) : (
          <>
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
                    onUninstall={handleUninstallConfig}
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
          </>
        )}
      </div>

      {/* Uninstall confirmation dialog */}
      <UninstallDeploymentConfigDialog
        config={configToUninstall}
        isOpen={uninstallDialogOpen}
        onClose={handleCloseUninstallDialog}
      />
    </div>
  );
}

export default DeploymentsPage;