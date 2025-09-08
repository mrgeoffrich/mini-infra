import { ContainerSummary } from "./ContainerSummary";
import { DeploymentSummary } from "./DeploymentSummary";

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
        <p className="text-muted-foreground mb-6">
          Overview of your Docker infrastructure and deployments
        </p>
      </div>
      <ContainerSummary />
      <DeploymentSummary />
    </div>
  );
}
