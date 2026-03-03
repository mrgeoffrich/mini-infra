import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconAlertCircle,
  IconBrandAzure,
  IconBrandDocker,
} from "@tabler/icons-react";
import { useAzureContainers } from "@/hooks/use-azure-settings";

export interface AzureContainerSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const AzureContainerSelector = React.memo(
  function AzureContainerSelector({
    value,
    onChange,
    disabled = false,
    placeholder = "Select a container...",
    className,
  }: AzureContainerSelectorProps) {
    // Fetch containers data
    const {
      data: containersData,
      isLoading,
      error,
    } = useAzureContainers({
      enabled: !disabled,
      refetchInterval: undefined, // Manual refresh only
    });

    // Loading state
    if (isLoading) {
      return <Skeleton className={`h-9 w-full ${className || ""}`} />;
    }

    // Error state
    if (error) {
      return (
        <Alert variant="destructive" className={className}>
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load containers: {error.message}
          </AlertDescription>
        </Alert>
      );
    }

    // No Azure configuration found
    if (!containersData?.data.containers) {
      return (
        <div className={className}>
          <Select disabled={true} value={value}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No Azure connection configured" />
            </SelectTrigger>
          </Select>
          <p className="text-sm text-muted-foreground mt-1.5">
            <IconBrandAzure className="inline h-3.5 w-3.5 mr-1" />
            Please configure Azure Storage connection first.
          </p>
        </div>
      );
    }

    // No containers available
    if (containersData.data.containers.length === 0) {
      return (
        <div className={className}>
          <Select disabled={true} value={value}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No containers available" />
            </SelectTrigger>
          </Select>
          <p className="text-sm text-muted-foreground mt-1.5">
            <IconBrandDocker className="inline h-3.5 w-3.5 mr-1" />
            No containers found in Azure Storage account.
          </p>
        </div>
      );
    }

    // Render selector with containers
    return (
      <div className={className}>
        <Select disabled={disabled} value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {containersData.data.containers.map((container) => (
              <SelectItem key={container.name} value={container.name}>
                <div className="flex items-center gap-2">
                  <IconBrandDocker className="h-4 w-4 text-blue-600" />
                  {container.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground mt-1.5">
          {containersData.data.containerCount} container
          {containersData.data.containerCount !== 1 ? "s" : ""} available in{" "}
          {containersData.data.accountName}
        </p>
      </div>
    );
  },
);
