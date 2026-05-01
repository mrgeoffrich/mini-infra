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
  IconCloud,
} from "@tabler/icons-react";
import { useStorageLocationsList } from "@/hooks/use-storage-settings";
import { StorageProviderId } from "@mini-infra/types";
import { GoogleDriveFolderInput } from "./providers/google-drive/GoogleDriveFolderInput";

export interface StorageLocationSelectorProps {
  provider: StorageProviderId | null;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Generic location selector. Today the Azure code path is the only one wired
 * — Drive lands in Phase 3 once `useStorageLocationsList("google-drive")`
 * gets a real implementation.
 */
export const StorageLocationSelector = React.memo(
  function StorageLocationSelector({
    provider,
    value,
    onChange,
    disabled = false,
    placeholder = "Select a location...",
    className,
  }: StorageLocationSelectorProps) {
    if (!provider) {
      return (
        <div className={className}>
          <Select disabled={true} value={value}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No storage provider selected" />
            </SelectTrigger>
          </Select>
          <p className="text-sm text-muted-foreground mt-1.5">
            <IconCloud className="inline h-3.5 w-3.5 mr-1" />
            Pick a storage provider first.
          </p>
        </div>
      );
    }

    if (provider === "google-drive") {
      return (
        <GoogleDriveFolderInput
          value={value}
          onChange={onChange}
          disabled={disabled}
          placeholder={placeholder ?? "Paste folder ID or Drive folder URL"}
          className={className}
        />
      );
    }

    return (
      <AzureLocationSelector
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        className={className}
      />
    );
  },
);

interface AzureLocationSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const AzureLocationSelector = React.memo(function AzureLocationSelector({
  value,
  onChange,
  disabled = false,
  placeholder = "Select a container...",
  className,
}: AzureLocationSelectorProps) {
  const {
    data: locationsData,
    isLoading,
    error,
  } = useStorageLocationsList("azure", {
    enabled: !disabled,
    refetchInterval: undefined,
  });

  if (isLoading) {
    return <Skeleton className={`h-9 w-full ${className || ""}`} />;
  }

  if (error) {
    return (
      <Alert variant="destructive" className={className}>
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load locations: {error.message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!locationsData?.locations) {
    return (
      <div className={className}>
        <Select disabled={true} value={value}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No Azure connection configured" />
          </SelectTrigger>
        </Select>
        <p className="text-sm text-muted-foreground mt-1.5">
          <IconBrandAzure className="inline h-3.5 w-3.5 mr-1" />
          Configure the Azure storage provider first.
        </p>
      </div>
    );
  }

  if (locationsData.locations.length === 0) {
    return (
      <div className={className}>
        <Select disabled={true} value={value}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No locations available" />
          </SelectTrigger>
        </Select>
        <p className="text-sm text-muted-foreground mt-1.5">
          <IconBrandAzure className="inline h-3.5 w-3.5 mr-1" />
          No locations found in the connected account.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <Select disabled={disabled} value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {locationsData.locations.map((loc) => (
            <SelectItem key={loc.name} value={loc.name}>
              <div className="flex items-center gap-2">
                <IconBrandAzure className="h-4 w-4 text-blue-600" />
                {loc.name}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground mt-1.5">
        {locationsData.locationCount} location
        {locationsData.locationCount !== 1 ? "s" : ""} available in{" "}
        {locationsData.accountName}
      </p>
    </div>
  );
});
