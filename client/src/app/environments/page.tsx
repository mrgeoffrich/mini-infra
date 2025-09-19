import { useState } from "react";
import { EnvironmentList, NetworkList, VolumeList } from "@/components/environments";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "react-router-dom";
import { Settings, Server, Network, HardDrive } from "lucide-react";

export function EnvironmentsPage() {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <Server className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Environments</h1>
              <p className="text-muted-foreground">
                Manage your service environments, networks, and volumes
              </p>
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link
              to="/connectivity/docker"
              className="flex items-center gap-2"
            >
              <Settings className="h-4 w-4" />
              Configure Docker
            </Link>
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <Tabs defaultValue="environments" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="environments" className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              Environments
            </TabsTrigger>
            <TabsTrigger value="networks" className="flex items-center gap-2" disabled={!selectedEnvironmentId}>
              <Network className="h-4 w-4" />
              Networks
            </TabsTrigger>
            <TabsTrigger value="volumes" className="flex items-center gap-2" disabled={!selectedEnvironmentId}>
              <HardDrive className="h-4 w-4" />
              Volumes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="environments" className="space-y-6">
            <EnvironmentList onEnvironmentSelect={setSelectedEnvironmentId} />

            {/* Help Card */}
            <Card>
              <CardHeader>
                <CardTitle>About Environments</CardTitle>
                <CardDescription>
                  Learn how to effectively manage your service environments
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-4 text-sm">
                  <div>
                    <strong>Environment Types:</strong> Production environments have additional
                    safety measures and confirmation steps for critical operations like
                    deletion and stopping services.
                  </div>
                  <div>
                    <strong>Services:</strong> Each environment can contain multiple services
                    that work together. Services are managed as a group within the environment.
                  </div>
                  <div>
                    <strong>Networks & Volumes:</strong> Environments automatically manage
                    Docker networks and volumes required by their services. You can also
                    manually create and manage these resources in the Networks and Volumes tabs.
                  </div>
                  <div>
                    <strong>Lifecycle Management:</strong> Start and stop entire environments
                    to control all services at once. Individual service health is monitored
                    and displayed.
                  </div>
                  <div>
                    <strong>Resource Isolation:</strong> Each environment maintains its own
                    isolated set of resources, preventing conflicts between different
                    service deployments.
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="networks">
            {selectedEnvironmentId ? (
              <NetworkList environmentId={selectedEnvironmentId} />
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Network className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">Select an Environment</h3>
                  <p className="text-muted-foreground text-center">
                    Choose an environment from the Environments tab to manage its networks.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="volumes">
            {selectedEnvironmentId ? (
              <VolumeList environmentId={selectedEnvironmentId} />
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <HardDrive className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">Select an Environment</h3>
                  <p className="text-muted-foreground text-center">
                    Choose an environment from the Environments tab to manage its volumes.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}