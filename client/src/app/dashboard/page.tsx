import { IconDashboard } from "@tabler/icons-react";
import { ContainerSummary } from "./ContainerSummary";

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconDashboard className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">
              Overview of your Docker infrastructure
            </p>
          </div>
        </div>
      </div>

      <ContainerSummary />
    </div>
  );
}
