import { EnvironmentList } from "@/components/environments";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Server } from "lucide-react";

export function EnvironmentsPage() {

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
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
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <div className="space-y-6">
          <EnvironmentList />

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
                  Click on an environment card to view and manage its services.
                </div>
                <div>
                  <strong>Networks & Volumes:</strong> Each environment has its own Docker
                  networks and volumes. You can manage these from the individual environment
                  page by clicking on an environment.
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
        </div>
      </div>
    </div>
  );
}