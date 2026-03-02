export interface AzureContainerListProps {
  className?: string;
}

export interface ContainerAccessTest {
  containerName: string;
  status: "testing" | "success" | "failed" | "idle";
  lastTested?: Date;
  responseTime?: number;
  error?: string;
}
