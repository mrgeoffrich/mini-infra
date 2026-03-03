import { IconDashboard } from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllServicesStatus } from "@/hooks/use-all-services-status";
import { ContainerSummary } from "./ContainerSummary";
import { WelcomeDashboard } from "./WelcomeDashboard";

export function DashboardPage() {
  const { isLoading, allDisconnected } = useAllServicesStatus();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6" data-tour="dashboard-header">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconDashboard className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">
              {allDisconnected && !isLoading
                ? "Get started by connecting your services"
                : "Overview of your Docker infrastructure"}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 lg:px-6 space-y-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        </div>
      ) : allDisconnected ? (
        <WelcomeDashboard />
      ) : (
        <ContainerSummary />
      )}
    </div>
  );
}
