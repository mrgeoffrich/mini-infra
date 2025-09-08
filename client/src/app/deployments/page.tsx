import { useState, useCallback, useMemo } from "react";
import {
  IconLayoutGrid,
  IconList,
  IconPlus,
} from "@tabler/icons-react";

import { DeploymentList } from "@/components/deployments/deployment-list";
import { DeploymentCard } from "@/components/deployments/deployment-card";
import { DeploymentConfigForm } from "@/components/deployments/deployment-config-form";
import { useDeploymentConfigs, useDeploymentConfigFilters } from "@/hooks/use-deployment-configs";
import { useActiveDeployments } from "@/hooks/use-deployment-history";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DeploymentConfigurationInfo, DeploymentInfo } from "@mini-infra/types";

export function DeploymentsPage() {
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<DeploymentConfigurationInfo | null>(null);
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

  const configs = configsResponse?.data || [];

  // Create a map of latest deployments by configuration
  const latestDeploymentsByConfig = useMemo(() => {
    const map = new Map<string, DeploymentInfo>();
    (activeDeploymentsResponse?.data || []).forEach((deployment) => {
      const existing = map.get(deployment.configurationId);
      if (!existing || new Date(deployment.startedAt) > new Date(existing.startedAt)) {
        map.set(deployment.configurationId, deployment);
      }
    });
    return map;
  }, [activeDeploymentsResponse?.data]);

  const handleEditConfig = useCallback((config: DeploymentConfigurationInfo) => {
    setEditingConfig(config);
    setIsFormOpen(true);
  }, []);

  const handleViewHistory = useCallback((config: DeploymentConfigurationInfo) => {
    // TODO: Navigate to deployment history page for this config
    console.log("View history for:", config);
  }, []);

  const handleCreateConfig = useCallback(() => {
    setEditingConfig(null);
    setIsFormOpen(true);
  }, []);

  const handleCloseForm = useCallback(() => {
    setIsFormOpen(false);
    setEditingConfig(null);
  }, []);

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
          onViewHistory={handleViewHistory}
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
                  onEdit={handleEditConfig}
                  onViewHistory={handleViewHistory}
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

      {/* Deployment Configuration Form Modal */}
      <DeploymentConfigForm
        deploymentConfig={editingConfig}
        isOpen={isFormOpen}
        onClose={handleCloseForm}
      />
    </div>
  );
}

export default DeploymentsPage;