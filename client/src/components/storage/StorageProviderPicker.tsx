import React, { useCallback, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconBrandAzure,
  IconBrandGoogleDrive,
  IconCircleCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { StorageProviderId } from "@mini-infra/types";
import { StorageSwitchConfirmDialog } from "./StorageSwitchConfirmDialog";

interface ProviderOption {
  id: StorageProviderId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "azure",
    label: "Azure Blob Storage",
    description: "Connect with an Azure Storage Account connection string.",
    icon: IconBrandAzure,
  },
  {
    id: "google-drive",
    label: "Google Drive",
    description: "Connect a Google Cloud OAuth client (drive.file scope).",
    icon: IconBrandGoogleDrive,
  },
];

export interface StorageProviderPickerProps {
  activeProviderId: StorageProviderId | null;
  isUpdating?: boolean;
  onProviderChange: (providerId: StorageProviderId) => void;
  className?: string;
}

export const StorageProviderPicker = React.memo(function StorageProviderPicker({
  activeProviderId,
  isUpdating,
  onProviderChange,
  className,
}: StorageProviderPickerProps) {
  const [pendingProviderId, setPendingProviderId] =
    useState<StorageProviderId | null>(null);

  const handleSelect = useCallback(
    (providerId: StorageProviderId) => {
      if (providerId === activeProviderId) return;

      // No active provider yet → no consequence-list confirmation needed; pick
      // straight away.
      if (!activeProviderId) {
        onProviderChange(providerId);
        return;
      }

      // Active provider already chosen → run the precheck-driven confirmation.
      setPendingProviderId(providerId);
    },
    [activeProviderId, onProviderChange],
  );

  const handleCancel = useCallback(() => {
    setPendingProviderId(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (pendingProviderId) {
      onProviderChange(pendingProviderId);
      setPendingProviderId(null);
    }
  }, [onProviderChange, pendingProviderId]);

  return (
    <TooltipProvider>
      <Card className={className} data-tour="storage-provider-picker">
        <CardHeader>
          <CardTitle>Storage Provider</CardTitle>
          <CardDescription>
            Pick a backend for postgres backups, self-backups, and TLS
            certificate storage. All three locations follow the active
            provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label="Storage provider"
            className="grid gap-3 sm:grid-cols-2"
          >
            {PROVIDER_OPTIONS.map((option) => {
              const isActive = activeProviderId === option.id;
              const isDisabled = option.disabled || isUpdating;
              const Icon = option.icon;

              const card = (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  disabled={isDisabled}
                  onClick={() => handleSelect(option.id)}
                  data-tour={`storage-provider-option-${option.id}`}
                  className={cn(
                    "relative w-full text-left rounded-lg border p-4 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-input hover:bg-accent/40",
                    isDisabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Icon className="h-6 w-6 shrink-0 text-foreground" />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{option.label}</span>
                        {isActive && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            <IconCircleCheck className="h-3 w-3" /> Active
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {option.description}
                      </p>
                      {option.disabled && option.disabledReason && (
                        <p className="text-xs text-muted-foreground italic">
                          {option.disabledReason}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );

              if (option.disabled && option.disabledReason) {
                return (
                  <Tooltip key={option.id}>
                    <TooltipTrigger asChild>
                      <div>{card}</div>
                    </TooltipTrigger>
                    <TooltipContent>{option.disabledReason}</TooltipContent>
                  </Tooltip>
                );
              }
              return card;
            })}
          </div>
        </CardContent>
      </Card>

      <StorageSwitchConfirmDialog
        pendingProviderId={pendingProviderId}
        currentProviderId={activeProviderId}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
        isSwitching={isUpdating}
      />
    </TooltipProvider>
  );
});
