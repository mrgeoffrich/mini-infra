import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContainerDashboard } from "./ContainerDashboard";
import { NetworksList } from "./NetworksList";
import { VolumesList } from "./VolumesList";
import { IconServer, IconNetwork, IconDatabase } from "@tabler/icons-react";

export function ContainersPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <h1 className="text-3xl font-bold mb-2">Docker Management</h1>
        <p className="text-muted-foreground">
          Manage Docker containers, networks, and volumes
        </p>
      </div>

      <div className="px-4 lg:px-6">
        <Tabs defaultValue="containers" className="w-full">
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
