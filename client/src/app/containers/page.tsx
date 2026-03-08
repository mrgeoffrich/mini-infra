import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContainerDashboard } from "./ContainerDashboard";
import { NetworksList } from "./NetworksList";
import { VolumesList } from "./VolumesList";
import { IconServer, IconNetwork, IconDatabase, IconBrandDocker } from "@tabler/icons-react";

const ACTIVE_TAB_STORAGE_KEY = "mini-infra:containers-active-tab";

type TabValue = "containers" | "networks" | "volumes";

function loadActiveTab(): TabValue {
  try {
    const stored = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (stored && ["containers", "networks", "volumes"].includes(stored)) {
      return stored as TabValue;
    }
  } catch (error) {
    console.error("Failed to load active tab from localStorage:", error);
  }
  return "containers";
}

export function ContainersPage() {
  const [activeTab, setActiveTab] = useState<TabValue>(loadActiveTab);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
    } catch (error) {
      console.error("Failed to save active tab to localStorage:", error);
    }
  }, [activeTab]);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconBrandDocker className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Container Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor and manage your Docker containers
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)} className="w-full" data-tour="containers-tabs">
          <TabsList>
            <TabsTrigger value="containers" className="gap-2">
              <IconServer className="h-4 w-4" />
              Containers
            </TabsTrigger>
            <TabsTrigger value="networks" className="gap-2">
              <IconNetwork className="h-4 w-4" />
              Networks
            </TabsTrigger>
            <TabsTrigger value="volumes" className="gap-2">
              <IconDatabase className="h-4 w-4" />
              Volumes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="containers">
            <ContainerDashboard />
          </TabsContent>

          <TabsContent value="networks">
            <NetworksList />
          </TabsContent>

          <TabsContent value="volumes">
            <VolumesList />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
